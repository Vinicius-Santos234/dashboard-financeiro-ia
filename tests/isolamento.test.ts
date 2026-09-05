import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth'
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  type Firestore,
} from 'firebase/firestore'

/**
 * O critério de aceite da E1 (spec §8).
 *
 * "Com dois usuários criados, A não lê nenhum documento de B — nem pelo SDK
 *  cliente nem por caminho montado à mão."
 *
 * Roda contra o projeto real, com o **SDK cliente**, que é o único caminho
 * onde as Security Rules valem. Testar com o Admin SDK não provaria nada:
 * ele ignora as regras por desenho (§4.4).
 *
 * Antes: `npm run seed:usuarios`.
 */

const CFG = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
}

const A_EMAIL = process.env.TEST_USER_A_EMAIL
const A_SENHA = process.env.TEST_USER_A_PASSWORD
const B_EMAIL = process.env.TEST_USER_B_EMAIL
const B_SENHA = process.env.TEST_USER_B_PASSWORD
const B_UID = process.env.TEST_USER_B_UID

const configurado = Boolean(
  CFG.apiKey && CFG.projectId && A_EMAIL && A_SENHA && B_EMAIL && B_SENHA && B_UID
)

/** Uma instância por usuário: sessões independentes, sem uma derrubar a outra. */
function novaInstancia(nome: string) {
  const app = initializeApp(CFG, nome)
  return { app, auth: getAuth(app), db: getFirestore(app) }
}

/**
 * Entra e, se falhar, diz **por quê** em vez de repassar o código do Firebase.
 *
 * `auth/invalid-credential` cru não ajuda quem lê o log do CI: a causa mais
 * provável ali não é senha digitada errada, é secret desatualizado depois de
 * uma rotação de senha — que é exatamente o que aconteceu na primeira vez que
 * este teste rodou em CI.
 */
async function entrar(auth: Auth, email: string, senha: string, quem: string) {
  try {
    return await signInWithEmailAndPassword(auth, email, senha)
  } catch (erro) {
    const codigo = (erro as { code?: string }).code ?? 'desconhecido'
    if (codigo === 'auth/invalid-credential' || codigo === 'auth/wrong-password') {
      throw new Error(
        `Login do usuário ${quem} (${email}) recusado (${codigo}).\n` +
          'Causa provável: a senha aqui não é a que está no Firebase.\n' +
          '  - Localmente: rode `npm run seed:usuarios`.\n' +
          '  - No CI: atualize os secrets TEST_USER_A_PASSWORD e ' +
          'TEST_USER_B_PASSWORD, que ficam desatualizados a cada rotação.'
      )
    }
    throw erro
  }
}

const TX_DE_B = 'h_teste_isolamento_do_b'

describe.skipIf(!configurado)('isolamento entre usuários', () => {
  let A: { app: FirebaseApp; auth: Auth; db: Firestore }
  let B: { app: FirebaseApp; auth: Auth; db: Firestore }
  let uidA: string
  let uidB: string

  beforeAll(async () => {
    A = novaInstancia('teste-a')
    B = novaInstancia('teste-b')

    uidA = (await entrar(A.auth, A_EMAIL!, A_SENHA!, 'A')).user.uid
    uidB = (await entrar(B.auth, B_EMAIL!, B_SENHA!, 'B')).user.uid
    expect(uidA).not.toBe(uidB)

    // B grava algo que A nunca deveria ver.
    await setDoc(doc(B.db, `users/${uidB}/transactions/${TX_DE_B}`), {
      accountId: 'conta-do-b',
      importId: null,
      occurredOn: '2026-08-14',
      month: '2026-08',
      amountCents: -4790,
      descriptionRaw: 'SEGREDO DO B',
      descriptionClean: 'SEGREDO DO B',
      fitid: null,
      category: null,
      categorySource: null,
      confidence: null,
      source: 'ofx',
      aiOptOut: false,
    })
  }, 60_000)

  afterAll(async () => {
    await signOut(A.auth).catch(() => {})
    await signOut(B.auth).catch(() => {})
    await deleteApp(A.app).catch(() => {})
    await deleteApp(B.app).catch(() => {})
  })

  it('B consegue ler o próprio documento', async () => {
    // Se este falhar, os outros passariam por motivo errado — negar tudo
    // também "isola".
    const snap = await getDoc(doc(B.db, `users/${uidB}/transactions/${TX_DE_B}`))
    expect(snap.exists()).toBe(true)
    expect(snap.data()!.descriptionRaw).toBe('SEGREDO DO B')
  })

  it('A não lê o documento de B nem sabendo o caminho exato', async () => {
    await expect(
      getDoc(doc(A.db, `users/${uidB}/transactions/${TX_DE_B}`))
    ).rejects.toThrow(/permission|insufficient/i)
  })

  it('A não lista a coleção de B', async () => {
    await expect(
      getDocs(collection(A.db, `users/${uidB}/transactions`))
    ).rejects.toThrow(/permission|insufficient/i)
  })

  it('A não escreve na árvore de B', async () => {
    await expect(
      setDoc(doc(A.db, `users/${uidB}/transactions/h_plantado_por_a`), {
        accountId: 'x',
        importId: null,
        occurredOn: '2026-08-14',
        month: '2026-08',
        amountCents: -100,
        descriptionRaw: 'PLANTADO',
        descriptionClean: 'PLANTADO',
        fitid: null,
        category: null,
        categorySource: null,
        confidence: null,
        source: 'ofx',
        aiOptOut: false,
      })
    ).rejects.toThrow(/permission|insufficient/i)
  })

  it('quem não fez login não lê nada', async () => {
    const anon = novaInstancia('anonimo')
    await expect(
      getDoc(doc(anon.db, `users/${uidB}/transactions/${TX_DE_B}`))
    ).rejects.toThrow(/permission|insufficient/i)
    await deleteApp(anon.app)
  })

  it('as regras recusam valor fracionário — centavos são inteiros', async () => {
    // O `check` do Postgres que virou regra. Sem isto, alguém grava 47.9
    // achando que são reais e o total do gráfico fica 100x errado.
    await expect(
      setDoc(doc(A.db, `users/${uidA}/transactions/h_valor_quebrado`), {
        accountId: 'x',
        importId: null,
        occurredOn: '2026-08-14',
        month: '2026-08',
        amountCents: 47.9,
        descriptionRaw: 'REAIS EM VEZ DE CENTAVOS',
        descriptionClean: 'REAIS EM VEZ DE CENTAVOS',
        fitid: null,
        category: null,
        categorySource: null,
        confidence: null,
        source: 'ofx',
        aiOptOut: false,
      })
    ).rejects.toThrow(/permission|insufficient/i)
  })

  it('as regras recusam `month` que não bate com `occurredOn`', async () => {
    // Sem isto a transação some do gráfico do mês certo e aparece no errado.
    await expect(
      setDoc(doc(A.db, `users/${uidA}/transactions/h_mes_torto`), {
        accountId: 'x',
        importId: null,
        occurredOn: '2026-08-14',
        month: '2026-07',
        amountCents: -100,
        descriptionRaw: 'MES ERRADO',
        descriptionClean: 'MES ERRADO',
        fitid: null,
        category: null,
        categorySource: null,
        confidence: null,
        source: 'ofx',
        aiOptOut: false,
      })
    ).rejects.toThrow(/permission|insufficient/i)
  })

  it('as regras recusam categoria fora do enum', async () => {
    await expect(
      setDoc(doc(A.db, `users/${uidA}/transactions/h_categoria_inventada`), {
        accountId: 'x',
        importId: null,
        occurredOn: '2026-08-14',
        month: '2026-08',
        amountCents: -100,
        descriptionRaw: 'X',
        descriptionClean: 'X',
        fitid: null,
        category: 'delivery',
        categorySource: 'ai',
        confidence: 0.9,
        source: 'ofx',
        aiOptOut: false,
      })
    ).rejects.toThrow(/permission|insufficient/i)
  })

  it('o cliente não escreve no rollup — ele é derivado', async () => {
    // Se o app pudesse escrever aqui, o número do gráfico poderia divergir
    // das transações sem nada quebrar. Spec §4.5.
    await expect(
      setDoc(doc(A.db, `users/${uidA}/rollups/2026-08`), {
        month: '2026-08',
        totalInCents: 999999,
        totalOutCents: 0,
        count: 1,
        byCategory: {},
      })
    ).rejects.toThrow(/permission|insufficient/i)
  })
})

describe.skipIf(configurado)('isolamento — configuração ausente', () => {
  it('avisa em vez de passar em silêncio', () => {
    // Suíte que passa porque não rodou é pior que uma que falha: produz sinal
    // verde falso exatamente onde a garantia mais importa.
    console.warn(
      '\n[isolamento.test.ts] PULADO: faltam variáveis no .env.local. ' +
        'Rode `npm run seed:usuarios`. O critério de aceite da E1 NÃO foi provado.\n'
    )
    expect(configurado).toBe(false)
  })
})
