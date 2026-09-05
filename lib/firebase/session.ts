import 'server-only'
import { cookies } from 'next/headers'
import { adminAuth } from './admin'

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

export type Sessao = { uid: string; email: string | null }

/** Troca o ID token do cliente por um cookie de sessão. */
export async function criarSessao(idToken: string): Promise<void> {
  // `checkRevoked` na verificação: se a conta foi desativada ou o token
  // revogado entre o login e esta chamada, não vira sessão.
  await adminAuth().verifyIdToken(idToken, true)

  const cookie = await adminAuth().createSessionCookie(idToken, {
    expiresIn: DURACAO_MS,
  })

  const store = await cookies()
  store.set(NOME, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: DURACAO_MS / 1000,
  })
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
    const claims = await adminAuth().verifySessionCookie(cookie, true)
    return { uid: claims.uid, email: claims.email ?? null }
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

export async function encerrarSessao(): Promise<void> {
  const store = await cookies()
  const cookie = store.get(NOME)?.value

  if (cookie) {
    try {
      const claims = await adminAuth().verifySessionCookie(cookie)
      // Revoga no servidor, não só apaga o cookie: sair numa máquina precisa
      // derrubar a sessão, não apenas esquecê-la nesta.
      await adminAuth().revokeRefreshTokens(claims.sub)
    } catch {
      // Cookie já inválido. Apagar mesmo assim.
    }
  }

  store.delete(NOME)
}
