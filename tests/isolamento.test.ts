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

/**
 * Um id de transação sob a árvore de B — que **não precisa existir**.
 *
 * As Security Rules são avaliadas antes de o Firestore ir olhar se há
 * documento no caminho, então A é barrada por estar fora da própria árvore, e
 * não por o documento faltar. É por isso que este teste não semeia nada.
 */
const DOC_DE_B = 'h_teste_isolamento_do_b'

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

    // NÃO existe seed aqui, e isso é uma correção.
    //
    // A versão anterior semeava um documento de B — primeiro pelo SDK cliente,
    // depois pelo Admin SDK. As duas estavam erradas por motivos diferentes:
    //
    //   - pelo cliente, aquele `setDoc` bem-sucedido ERA a prova de que existia
    //     escrita direta do cliente, capaz de quebrar a invariante
    //     transação↔rollup. O teste demonstrava o buraco e ninguém leu assim.
    //
    //   - pelo Admin SDK, o teste passou a exigir a chave de serviço — que
    //     deliberadamente NÃO está nos secrets do CI, por ser a credencial mais
    //     poderosa do projeto. O teste quebrou no CI por depender de algo que a
    //     gente decidiu não ter lá.
    //
    // E o seed nunca foi necessário: as Security Rules avaliam **caminho, não
    // existência**. A tentando ler sob o uid de B é negada mesmo que não haja
    // documento nenhum ali. O seed só servia ao controle positivo, que agora é
    // feito de outro jeito — B listando a própria coleção, que resolve mesmo
    // vazia.
  }, 60_000)

  afterAll(async () => {
    await signOut(A.auth).catch(() => {})
    await signOut(B.auth).catch(() => {})
    await deleteApp(A.app).catch(() => {})
    await deleteApp(B.app).catch(() => {})
  })

  it('B lê a própria árvore — o mesmo caminho que A não lê', async () => {
    // O controle positivo, e ele é indispensável: sem ele, o teste seguinte
    // passaria igual se a leitura estivesse negada para todo mundo, ou se o
    // caminho simplesmente não existisse. Aqui fica provado que
    // `users/{uidB}/transactions` É legível — só que apenas pelo dono.
    //
    // Listar resolve mesmo com a coleção vazia, então isto não depende de
    // nenhum dado semeado. E não pode depender: o cliente perdeu a escrita, e
    // semear pelo Admin SDK exigiria a chave de serviço, que de propósito não
    // está nos secrets do CI.
    await expect(
      getDocs(collection(B.db, `users/${uidB}/transactions`))
    ).resolves.toBeDefined()
  })

  it('A não lê sob o uid de B nem sabendo o caminho exato', async () => {
    // Negado pelo CAMINHO, não pela existência: a regra é avaliada antes de o
    // Firestore olhar se há documento ali.
    await expect(
      getDoc(doc(A.db, `users/${uidB}/transactions/${DOC_DE_B}`))
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

  it('A não escreve nem na PRÓPRIA árvore — o cliente não escreve nada', async () => {
    // A garantia que substituiu a anterior. Enquanto as regras permitiam
    // `create, update, delete: if dono(uid)`, qualquer usuário autenticado
    // gravava direto pelo SDK cliente, sem passar pelo servidor — e o servidor
    // é quem mantém o rollup na mesma transação.
    await expect(
      setDoc(doc(A.db, `users/${uidA}/transactions/h_escrita_direta`), {
        accountId: 'x',
        importId: null,
        occurredOn: '2026-08-14',
        month: '2026-08',
        amountCents: -100,
        descriptionRaw: 'ESCRITA DIRETA',
        descriptionClean: 'ESCRITA DIRETA',
        fitid: null,
        category: null,
        categorySource: null,
        confidence: null,
        source: 'ofx',
        aiOptOut: false,
      })
    ).rejects.toThrow(/permission|insufficient/i)
  })

  it('A continua LENDO a própria árvore', async () => {
    // Par do teste acima: negar a escrita do cliente não podia custar a
    // leitura, senão o app inteiro para de renderizar. É o que separa "o
    // cliente só lê" de "o cliente não faz nada".
    await expect(
      getDocs(collection(A.db, `users/${uidA}/transactions`))
    ).resolves.toBeDefined()
  })

  it('quem não fez login não lê nada', async () => {
    const anon = novaInstancia('anonimo')
    await expect(
      getDoc(doc(anon.db, `users/${uidB}/transactions/${DOC_DE_B}`))
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

  it('as regras impedem entrada positiva fora de Receita', async () => {
    await expect(
      setDoc(doc(A.db, `users/${uidA}/transactions/h_entrada_como_gasto`), {
        accountId: 'x',
        importId: null,
        occurredOn: '2026-08-14',
        month: '2026-08',
        amountCents: 10000,
        descriptionRaw: 'ENTRADA',
        descriptionClean: 'ENTRADA',
        fitid: null,
        category: 'alimentacao',
        categorySource: 'user',
        confidence: null,
        source: 'ofx',
        aiOptOut: false,
      })
    ).rejects.toThrow(/permission|insufficient/i)
  })

  it('as regras recusam confiança fora de 0 a 1', async () => {
    await expect(
      setDoc(doc(A.db, `users/${uidA}/transactions/h_confianca_invalida`), {
        accountId: 'x',
        importId: null,
        occurredOn: '2026-08-14',
        month: '2026-08',
        amountCents: -100,
        descriptionRaw: 'X',
        descriptionClean: 'X',
        fitid: null,
        category: 'outros',
        categorySource: 'ai',
        confidence: 4,
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
