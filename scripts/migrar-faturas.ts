/**
 * Move o histórico de um cartão do mês civil para a fatura. Spec 003 §8 C8.
 *
 * Esta é a única operação do app que **pode corromper dado histórico**: ela
 * reescreve a chave de período (`month`) de transações já gravadas, e com ela
 * todo agregado que depende dessa chave. Por isso ela é a última etapa da
 * spec, roda em simulação por padrão, e exige o id do projeto para escrever.
 *
 *   npm run migrar:faturas -- --email=voce@exemplo.com
 *   npm run migrar:faturas -- --email=voce@exemplo.com --apply --project=<id>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { adminAuth, adminDb } from '../lib/firebase/admin'
import { diaDeFechamentoValido, periodoDaFatura } from '../lib/domain/invoice'
import {
  calcularRollup,
  divergencias,
  totalNetExpenseCents,
  type LinhaAgregavel,
} from '../lib/firestore/rollup'

type Doc = FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>

function argument(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

const envFile = argument('env-file')
config({ path: envFile ?? '.env.local', quiet: true })

const credential = argument('credential')
if (credential) {
  const data = JSON.parse(readFileSync(credential, 'utf8'))
  process.env.FIREBASE_PROJECT_ID = data.project_id
  process.env.FIREBASE_CLIENT_EMAIL = data.client_email
  process.env.FIREBASE_PRIVATE_KEY = data.private_key
}

function plain(value: unknown): unknown {
  if (value && typeof value === 'object' && 'toDate' in value) {
    const timestamp = value as { toDate(): Date }
    return { __firestoreTimestamp: timestamp.toDate().toISOString() }
  }
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)])
    )
  }
  return value
}

function docsForBackup(docs: readonly Doc[]) {
  return docs.map((doc) => ({ id: doc.id, data: plain(doc.data()) }))
}

type Escrita =
  | { tipo: 'update'; ref: FirebaseFirestore.DocumentReference; dados: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> }
  | { tipo: 'set'; ref: FirebaseFirestore.DocumentReference; dados: FirebaseFirestore.DocumentData }
  | { tipo: 'delete'; ref: FirebaseFirestore.DocumentReference }

const OPERACOES_POR_LOTE = 400

async function aplicarEmLotes(
  db: FirebaseFirestore.Firestore,
  escritas: readonly Escrita[]
): Promise<void> {
  for (let i = 0; i < escritas.length; i += OPERACOES_POR_LOTE) {
    const batch = db.batch()
    for (const e of escritas.slice(i, i + OPERACOES_POR_LOTE)) {
      if (e.tipo === 'update') batch.update(e.ref, e.dados)
      else if (e.tipo === 'set') batch.set(e.ref, e.dados)
      else batch.delete(e.ref)
    }
    await batch.commit()
  }
}

async function main() {
  const email = argument('email')?.trim()
  const expectedProject = argument('project')?.trim()
  const apenasConta = argument('account')?.trim()
  const apply = process.argv.includes('--apply')

  if (!email) {
    throw new Error('Informe --email. Sem isso nada é alterado.')
  }
  if (apply && !expectedProject) {
    throw new Error('--apply exige --project para impedir escrita no Firebase errado.')
  }
  if (expectedProject && process.env.FIREBASE_PROJECT_ID !== expectedProject) {
    throw new Error('O projeto Firebase não corresponde ao --project. Nada foi alterado.')
  }

  const user = await adminAuth().getUserByEmail(email)
  const db = adminDb()
  const base = `users/${user.uid}`

  const [transactionsSnap, accountsSnap, rollupsSnap, insightsSnap] = await Promise.all([
    db.collection(`${base}/transactions`).get(),
    db.collection(`${base}/accounts`).get(),
    db.collection(`${base}/rollups`).get(),
    db.collection(`${base}/insights`).get(),
  ])

  // Só cartões COM fechamento configurado. Sem ele, o período correto é o mês
  // civil, que é onde a transação já está — não há o que migrar, e inventar um
  // fechamento aqui seria adivinhar exatamente o que a C8 não pode adivinhar.
  const cartoes = accountsSnap.docs.filter((doc) => {
    const dados = doc.data()
    if (dados.kind !== 'credit_card') return false
    if (!diaDeFechamentoValido(dados.closingDay)) return false
    return apenasConta ? doc.id === apenasConta : true
  })

  if (cartoes.length === 0) {
    throw new Error(
      'Nenhum cartão com dia de fechamento configurado. Configure em /conta antes de migrar.'
    )
  }

  const fechamentoPorConta = new Map(
    cartoes.map((doc) => [doc.id, doc.data().closingDay as number])
  )

  // A projeção: todo documento, com o `month` que ele passará a ter. Os que
  // não pertencem a um cartão migrado ficam exatamente como estão.
  const projetado = new Map<string, FirebaseFirestore.DocumentData>()
  for (const doc of transactionsSnap.docs) projetado.set(doc.id, { ...doc.data() })

  const mudancas: { doc: Doc; de: string; para: string }[] = []
  for (const doc of transactionsSnap.docs) {
    const dados = doc.data()
    const fechamento = fechamentoPorConta.get(dados.accountId)
    if (fechamento === undefined) continue

    const de = dados.month as string
    const para = periodoDaFatura(dados.occurredOn as string, fechamento)
    if (de === para) continue

    mudancas.push({ doc, de, para })
    projetado.set(doc.id, { ...dados, month: para })
  }

  // Todo mês tocado — o de origem e o de destino. Esquecer os de origem
  // deixaria agregado velho com transações que já não estão nele, que é
  // exatamente a corrupção silenciosa que esta etapa arrisca.
  const mesesAfetados = [
    ...new Set(mudancas.flatMap(({ de, para }) => [de, para])),
  ].sort()

  /**
   * A projeção existe **só para o relatório da simulação**.
   *
   * Ela já foi gravada no banco, e isso era um defeito: calculada de uma
   * leitura do começo da execução e escrita depois com `set`, ela apagava
   * qualquer importação que tivesse acontecido no meio. Quem grava agora é
   * `recalcularEConferir`, que recalcula do estado atual dentro de uma
   * transação. Aqui ela só responde *"o que eu espero que aconteça"*.
   */
  const rollupsProjetados = new Map(
    mesesAfetados.map((mes) => {
      const linhas: LinhaAgregavel[] = [...projetado.values()]
        .filter((d) => d.month === mes)
        .map((d) => ({
          month: d.month,
          amountCents: d.amountCents,
          flowType: d.flowType,
          category: d.category ?? null,
          accountKind: d.accountKind,
        }))
      return [mes, calcularRollup(mes, linhas)]
    })
  )

  /**
   * A conferência que o critério de aceite pede: **a soma das faturas bate com
   * a soma das transações**.
   *
   * Migrar mexe na divisão entre períodos, e não no dinheiro. Se o total geral
   * mudar, alguma linha foi para um mês que o recálculo não cobriu — e é
   * melhor descobrir isso antes de escrever do que depois.
   */
  const somaDe = (docs: FirebaseFirestore.DocumentData[]) =>
    docs.reduce((acc, d) => acc + Math.abs(d.amountCents as number), 0)

  const totalAntes = somaDe(transactionsSnap.docs.map((d) => d.data()))
  const totalDepois = somaDe([...projetado.values()])
  if (totalAntes !== totalDepois) {
    throw new Error(
      `A soma das transações mudou (${totalAntes} → ${totalDepois}). Nada foi alterado.`
    )
  }

  const porDestino = Object.fromEntries(
    [...new Set(mudancas.map((m) => m.para))].sort().map((mes) => [
      mes,
      mudancas.filter((m) => m.para === mes).length,
    ])
  )

  const totais = Object.fromEntries(
    [...rollupsProjetados].map(([mes, rollup]) => [
      mes,
      {
        count: rollup.count,
        grossExpenseCents: Math.abs(rollup.totalOutCents),
        refundCents: rollup.totalRefundCents,
        transferCents: rollup.totalTransferCents,
        netExpenseCents: totalNetExpenseCents(rollup),
      },
    ])
  )

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        projectId: process.env.FIREBASE_PROJECT_ID,
        uid: user.uid,
        email: user.email,
        cartoes: cartoes.map((doc) => ({
          id: doc.id,
          name: doc.data().name,
          closingDay: doc.data().closingDay,
        })),
        transacoesQueMudamDePeriodo: mudancas.length,
        mesesAfetados,
        paraCadaFatura: porDestino,
        totaisProjetados: totais,
        rollupsQueFicamVazios: [...rollupsProjetados]
          .filter(([, r]) => r.count === 0)
          .map(([mes]) => mes),
      },
      null,
      2
    )
  )

  /**
   * "Nada muda" não é o mesmo que "nada a fazer".
   *
   * As transações são movidas antes dos agregados. Se a execução morrer entre
   * as duas etapas, as linhas já estão no período novo e os rollups ainda
   * descrevem o antigo — e na segunda execução `mudancas.length` é zero,
   * porque as transações já estão onde deveriam. A versão anterior encerrava
   * aqui e deixava o banco inconsistente **sem caminho de volta pelo próprio
   * script**.
   *
   * Por isso a conferência roda sempre: ela varre os períodos ocupados pelos
   * cartões migrados e diz se algum agregado diverge do recálculo.
   */
  const periodosDosCartoes = [
    ...new Set(
      [...projetado.values()]
        .filter((d) => fechamentoPorConta.has(d.accountId as string))
        .map((d) => d.month as string)
    ),
  ].sort()

  if (mudancas.length === 0) {
    console.log('\nNenhuma transação muda de período.')
    const pendentes = await periodosDivergentes(db, base, periodosDosCartoes)
    if (pendentes.length === 0) {
      console.log('Os agregados conferem. Nada a fazer.')
      return
    }
    console.log(
      `\nMas ${pendentes.length} período(s) estão com o agregado divergente: ` +
        `${pendentes.join(', ')}.\n` +
        'É a marca de uma migração interrompida no meio.'
    )
    if (!apply) {
      console.log('Repita com --apply --project=<id> para recalcular.')
      return
    }
    await recalcularEConferir(db, base, pendentes)
    return
  }

  if (!apply) {
    console.log('\nSimulação. Repita com --apply --project=<id> para escrever.')
    return
  }

  const backupDirectory = resolve('.local-backups')
  mkdirSync(backupDirectory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = resolve(backupDirectory, `faturas-${user.uid}-${stamp}.json`)
  writeFileSync(
    backupPath,
    JSON.stringify(
      plain({
        projectId: process.env.FIREBASE_PROJECT_ID,
        uid: user.uid,
        createdAt: new Date().toISOString(),
        accounts: docsForBackup(cartoes),
        transactions: docsForBackup(mudancas.map((m) => m.doc)),
        rollups: docsForBackup(
          rollupsSnap.docs.filter((d) => mesesAfetados.includes(d.id))
        ),
        insights: docsForBackup(
          insightsSnap.docs.filter((d) => mesesAfetados.includes(d.id))
        ),
      })
    ),
    'utf8'
  )
  console.log(`\nBackup em ${backupPath}`)

  await aplicarEmLotes(db, [
    ...mudancas.map(({ doc, para }) => ({
      tipo: 'update' as const,
      ref: doc.ref,
      dados: { month: para },
    })),
  ])

  // Insight gerado sobre os números antigos vira mentira no instante em que o
  // período muda. Some antes do recálculo, para não sobrar leitura de um
  // agregado que deixou de valer.
  await aplicarEmLotes(
    db,
    mesesAfetados.map((mes) => ({
      tipo: 'delete' as const,
      ref: db.doc(`${base}/insights/${mes}`),
    }))
  )

  const problemas = await recalcularEConferir(db, base, mesesAfetados)

  if (problemas.length > 0) {
    console.error('\nDIVERGÊNCIAS APÓS A MIGRAÇÃO:')
    for (const p of problemas) console.error(`  ${p}`)
    console.error(`\nO backup está em ${backupPath}.`)
    process.exitCode = 1
    return
  }

  console.log(
    `\nMigração concluída: ${mudancas.length} transações movidas, ` +
      `${mesesAfetados.length} períodos recalculados e conferidos.`
  )
}

/**
 * Recalcula cada período **do estado atual do banco**, dentro de uma
 * transação, e confere relendo depois.
 *
 * A versão anterior gravava uma projeção calculada no começo da execução, com
 * `set` e fora de transação. Entre a leitura e a escrita cabe uma importação
 * do usuário: uma revisão externa reproduziu R$ 20 entrando enquanto a
 * migração movia R$ 100, e o agregado terminou afirmando R$ 100 para
 * transações que somavam R$ 120. A conferência acusava, mas o banco já estava
 * errado.
 *
 * `recalcularRollup` lê as transações e grava o agregado **na mesma transação
 * do Firestore**: a escrita concorrente força retentativa em vez de ser
 * descartada. É a mesma função que o app usa como botão de conserto, e é
 * idempotente — rodar duas vezes dá no mesmo.
 */
async function recalcularEConferir(
  db: FirebaseFirestore.Firestore,
  base: string,
  periodos: readonly string[]
): Promise<string[]> {
  const uid = base.split('/')[1]
  const { recalcularRollup } = await import('../lib/firestore/repo')

  for (const mes of periodos) {
    const novo = await recalcularRollup(uid, mes)
    // Período que ficou vazio não deve deixar um agregado de zeros para trás:
    // ele apareceria na tendência como um mês existente e sem gasto.
    if (novo.count === 0) await db.doc(`${base}/rollups/${mes}`).delete()
  }

  return conferirPeriodos(db, base, periodos)
}

/** Relê do banco e compara cada agregado com o recálculo do zero. */
async function conferirPeriodos(
  db: FirebaseFirestore.Firestore,
  base: string,
  periodos: readonly string[]
): Promise<string[]> {
  const problemas: string[] = []
  const depoisSnap = await db.collection(`${base}/transactions`).get()

  for (const mes of periodos) {
    const linhas: LinhaAgregavel[] = depoisSnap.docs
      .map((d) => d.data())
      .filter((d) => d.month === mes)
      .map((d) => ({
        month: d.month,
        amountCents: d.amountCents,
        flowType: d.flowType,
        category: d.category ?? null,
        accountKind: d.accountKind,
      }))

    const real = calcularRollup(mes, linhas)
    const gravadoSnap = await db.doc(`${base}/rollups/${mes}`).get()

    if (!gravadoSnap.exists) {
      if (real.count > 0) {
        problemas.push(`${mes}: rollup ausente com ${real.count} transações`)
      }
      continue
    }
    for (const d of divergencias(gravadoSnap.data() as never, real)) {
      problemas.push(`${mes}: ${d}`)
    }
  }

  return problemas
}

/** Só os períodos cujo agregado não bate com o recálculo. */
async function periodosDivergentes(
  db: FirebaseFirestore.Firestore,
  base: string,
  periodos: readonly string[]
): Promise<string[]> {
  const problemas = await conferirPeriodos(db, base, periodos)
  return [...new Set(problemas.map((p) => p.split(':')[0]))].sort()
}

main().catch((erro) => {
  console.error(erro instanceof Error ? erro.message : erro)
  process.exitCode = 1
})
