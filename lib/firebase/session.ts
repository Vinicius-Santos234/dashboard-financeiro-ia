import 'server-only'
import { cookies } from 'next/headers'
import { adminAuth } from './admin'
import { ContaDemoError, ehEmailDemo } from '@/lib/domain/demo'
import { contaDemo } from './demo'

/**
 * Sessão por cookie httpOnly.
 *
 * O Firebase Auth é client-SDK-first: o login acontece no browser e produz um
 * ID token de vida curta, guardado em `localStorage`. Isso não serve para
 * Server Component — e um token em `localStorage` é legível por qualquer
 * script que entre na página.
 *
 * O caminho oficial para SSR é trocar o ID token por um **session cookie**
 * assinado pelo Admin SDK: `httpOnly`, `secure`, e verificável no servidor sem
 * ida à rede a cada request.
 */

const NOME = 'sessao'
const DURACAO_MS = 60 * 60 * 24 * 5 * 1000 // 5 dias
// Marcador público: só permite ler a conta demo fixada no servidor. Não é um
// token Firebase, não contém uid e não concede acesso a nenhuma conta pessoal.
const COOKIE_DEMO = 'demo-readonly-v1'

async function gravarCookie(valor: string) {
  const store = await cookies()
  store.set(NOME, valor, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: DURACAO_MS / 1000,
  })
}

export async function criarSessaoDemo(): Promise<void> {
  await contaDemo()
  await gravarCookie(COOKIE_DEMO)
}

export type Sessao = {
  uid: string
  email: string | null
  /** Conta pública de demonstração: pode ler tudo, não pode escrever nada. */
  demo: boolean
}

/** Troca o ID token do cliente por um cookie de sessão. */
/** Um ID token só vira sessão de 5 dias se o login for recente. */
const MAX_IDADE_LOGIN_S = 5 * 60

export async function criarSessao(idToken: string): Promise<void> {
  // `checkRevoked` na verificação: se a conta foi desativada ou o token
  // revogado entre o login e esta chamada, não vira sessão.
  const claims = await adminAuth().verifyIdToken(idToken, true)
  if (ehEmailDemo(claims.email) || claims.uid === process.env.FIREBASE_DEMO_UID) {
    throw new ContaDemoError('Login por senha')
  }

  // `auth_time` é quando a pessoa realmente autenticou, e não quando o token
  // foi emitido — um ID token é renovado sozinho por até uma hora. Sem esta
  // checagem, um token roubado e ainda válido seria promovido a um cookie de
  // CINCO DIAS, que é uma escalada e tanto para quem só interceptou um
  // instante da sessão.
  const idadeLogin = Date.now() / 1000 - claims.auth_time
  if (idadeLogin > MAX_IDADE_LOGIN_S) {
    throw new Error('Login antigo demais para abrir sessão. Entre novamente.')
  }

  const cookie = await adminAuth().createSessionCookie(idToken, {
    expiresIn: DURACAO_MS,
  })

  await gravarCookie(cookie)
}

/**
 * Lê a sessão do request, ou `null`.
 *
 * Verifica a assinatura a cada chamada. Confiar no cookie sem verificar seria
 * o mesmo erro de usar `getSession()` em vez de `getUser()`: cookie é dado do
 * cliente, e dado do cliente não é prova de nada.
 */
export async function lerSessao(): Promise<Sessao | null> {
  const store = await cookies()
  const cookie = store.get(NOME)?.value
  if (!cookie) return null

  try {
    if (cookie === COOKIE_DEMO) return await contaDemo()
    const claims = await adminAuth().verifySessionCookie(cookie, true)
    const email = claims.email ?? null
    // Cookies antigos da identidade Firebase da demo não são aceitos.
    if (ehEmailDemo(email) || claims.uid === process.env.FIREBASE_DEMO_UID) return null
    return { uid: claims.uid, email, demo: false }
  } catch {
    // Expirado, revogado ou adulterado — os três dão no mesmo: sem sessão.
    return null
  }
}

/**
 * A sessão, ou erro.
 *
 * Toda rota autenticada usa esta e não `lerSessao()`, porque o `uid` que sai
 * daqui é o primeiro argumento de tudo em `lib/firestore/repo.ts`. Devolver
 * `null` silenciosamente aqui viraria um caminho montado com `undefined`.
 */
export async function exigirSessao(): Promise<Sessao> {
  const sessao = await lerSessao()
  if (!sessao) throw new Error('Sem sessão.')
  return sessao
}

/**
 * A sessão, e recusa se for a conta demo.
 *
 * Toda rota ou action que ESCREVE usa esta, e não `exigirSessao`. A diferença
 * está no nome de propósito: quem escrever uma rota nova e chamar a errada
 * está abrindo a demo para escrita, e isso precisa ser visível na chamada.
 */
export async function exigirSessaoGravavel(acao?: string): Promise<Sessao> {
  const sessao = await exigirSessao()
  if (sessao.demo) throw new ContaDemoError(acao)
  return sessao
}

/**
 * Encerra a sessão desta máquina.
 *
 * `revogarTudo` derruba as sessões de **todos** os dispositivos daquele uid, e
 * por isso é opcional: numa conta pessoal é o comportamento desejado ao sair,
 * mas a conta demo é **compartilhada por visitantes anônimos**, e um deles
 * clicando em "Sair" derrubaria a sessão de todos os outros que estivessem
 * navegando naquele momento.
 */
export async function encerrarSessao(revogarTudo = true): Promise<void> {
  const store = await cookies()
  const cookie = store.get(NOME)?.value

  if (cookie && cookie !== COOKIE_DEMO && revogarTudo) {
    try {
      const claims = await adminAuth().verifySessionCookie(cookie)
      await adminAuth().revokeRefreshTokens(claims.sub)
    } catch {
      // Cookie já inválido. Apagar mesmo assim.
    }
  }

  // Apagar o cookie basta para sair aqui: sem ele, nenhuma rota reconhece a
  // sessão, e o SDK cliente já foi deslogado no login.
  store.delete(NOME)
}
