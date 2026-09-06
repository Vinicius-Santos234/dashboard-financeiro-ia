import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { FieldValue } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '../lib/firebase/admin'
import {
  classifyFlow,
  STATEMENT_PROFILES,
  type FlowType,
  type StatementProfile,
} from '../lib/domain/financial-flow'
import {
  calcularRollup,
  totalNetExpenseCents,
  type LinhaAgregavel,
} from '../lib/firestore/rollup'

type Doc = FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>

function argument(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

function argumentsFor(name: string): string[] {
  return process.argv
    .filter((arg) => arg.startsWith(`--${name}=`))
    .map((arg) => arg.slice(name.length + 3))
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

/**
 * O perfil é DECLARADO, nunca adivinhado — e isso custou um defeito.
 *
 * A versão anterior deduzia do `source`: todo CSV virava fatura "positivo é
 * compra". Passado num extrato de CONTA CORRENTE, cada despesa (negativa) cai
 * do lado do crédito e vira `refund`; e `categoriaMigrada`, para estorno,
 * preserva a categoria que o documento já tinha. O que estava em `outros`
 * ficava em `outros` para sempre — e, como `category` deixava de ser `null`,
 * aquelas linhas nunca mais entravam na fila de pendentes, então a IA nunca
 * mais as revisitava.
 *
 * Não há como o script saber que arquivo é aquele: só quem exportou sabe. A
 * correção é parar de fingir que sabe.
 */
function perfilDeclarado(): StatementProfile {
  const bruto = argument('profile')
  if (!bruto) {
    throw new Error(
      'Informe --profile. O script NÃO adivinha o tipo do extrato.\n' +
        '  --profile=bank_account                     conta corrente (positivo é entrada)\n' +
        '  --profile=credit_card_positive_expenses    fatura Nubank (positivo é compra)\n' +
        '  --profile=credit_card_negative_expenses    fatura em que negativo é compra'
    )
  }
  if (!(STATEMENT_PROFILES as readonly string[]).includes(bruto)) {
    throw new Error(`--profile inválido: ${bruto}. Use um de: ${STATEMENT_PROFILES.join(', ')}.`)
  }
  return bruto as StatementProfile
}

function migratedCategory(
  flowType: FlowType,
  data: FirebaseFirestore.DocumentData,
  recategorizar: boolean
): Pick<FirebaseFirestore.DocumentData, 'category' | 'categorySource' | 'confidence'> {
  const pendente = { category: null, categorySource: null, confidence: null }

  if (flowType === 'income') {
    return { category: 'receita', categorySource: 'rule', confidence: 1 }
  }
  if (flowType === 'transfer') {
    return { category: 'outros', categorySource: 'rule', confidence: 1 }
  }
  // Categoria de entrada num lançamento que afinal é gasto: sempre inválida.
  if (data.category === 'receita') return pendente

  // `--recategorizar` devolve à fila o que a IA decidiu sobre o valor com o
  // sinal errado. Sem isto não há caminho de volta: uma vez que `category`
  // deixa de ser `null`, a transação nunca mais é pendente, e o palpite errado
  // fica gravado para sempre.
  //
  // Só o que veio da IA. Escolha manual do usuário é dado, não palpite — e
  // regra tem dono e volta sozinha.
  if (recategorizar && data.categorySource === 'ai') return pendente

  return {
    category: data.category ?? null,
    categorySource: data.categorySource ?? null,
    confidence: data.confidence ?? null,
  }
}

function plain(value: unknown): unknown {
  if (value && typeof value === 'object' && 'toDate' in value) {
    const timestamp = value as { toDate(): Date }
    return { __firestoreTimestamp: timestamp.toDate().toISOString() }
  }
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, plain(item)])
    )
  }
  return value
}

function docsForBackup(docs: readonly Doc[]) {
  return docs.map((doc) => ({ id: doc.id, data: plain(doc.data()) }))
}

/** Uma escrita pendente, para poder fatiá-las sem repetir a montagem. */
type Escrita =
  | { tipo: 'update'; ref: FirebaseFirestore.DocumentReference; dados: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> }
  | { tipo: 'set'; ref: FirebaseFirestore.DocumentReference; dados: FirebaseFirestore.DocumentData }
  | { tipo: 'delete'; ref: FirebaseFirestore.DocumentReference }

/** O teto real é 500; 400 deixa folga para o dia em que alguém somar escrita. */
const OPERACOES_POR_LOTE = 400

async function aplicarEmLotes(
  db: FirebaseFirestore.Firestore,
  escritas: readonly Escrita[]
): Promise<void> {
  for (let i = 0; i < escritas.length; i += OPERACOES_POR_LOTE) {
    const batch = db.batch()
    for (const escrita of escritas.slice(i, i + OPERACOES_POR_LOTE)) {
      if (escrita.tipo === 'update') batch.update(escrita.ref, escrita.dados)
      else if (escrita.tipo === 'set') batch.set(escrita.ref, escrita.dados)
      else batch.delete(escrita.ref)
    }
    await batch.commit()
  }
}

async function main() {
  const email = argument('email')?.trim()
  const expectedProject = argument('project')?.trim()
  const filenames = new Set(argumentsFor('file'))
  const apply = process.argv.includes('--apply')
  const recategorizar = process.argv.includes('--recategorizar')
  const financialProfile = perfilDeclarado()

  if (!email || filenames.size === 0) {
    throw new Error('Informe --email e pelo menos um --file. Sem isso nada é alterado.')
  }
  if (apply && !expectedProject) {
    throw new Error('--apply exige --project para impedir escrita no Firebase errado.')
  }
  if (expectedProject && process.env.FIREBASE_PROJECT_ID !== expectedProject) {
    throw new Error('O projeto Firebase não corresponde ao --project. Nenhuma alteração realizada.')
  }

  const user = await adminAuth().getUserByEmail(email)
  const db = adminDb()
  const base = `users/${user.uid}`
  const [importsSnap, transactionsSnap, accountsSnap, rollupsSnap, insightsSnap] =
    await Promise.all([
      db.collection(`${base}/imports`).get(),
      db.collection(`${base}/transactions`).get(),
      db.collection(`${base}/accounts`).get(),
      db.collection(`${base}/rollups`).get(),
      db.collection(`${base}/insights`).get(),
    ])

  const imports = importsSnap.docs.filter((doc) => filenames.has(doc.data().filename))
  const foundNames = new Set(imports.map((doc) => doc.data().filename as string))
  const missing = [...filenames].filter((name) => !foundNames.has(name))
  if (missing.length > 0) {
    throw new Error(`Importações não encontradas: ${missing.join(', ')}. Nada foi alterado.`)
  }

  const importsById = new Map(imports.map((doc) => [doc.id, doc.data()]))
  const targetTransactions = transactionsSnap.docs.filter((doc) =>
    importsById.has(doc.data().importId)
  )
  const expectedCount = Number(argument('expected-count') ?? targetTransactions.length)
  if (targetTransactions.length !== expectedCount) {
    throw new Error(
      `Esperava ${expectedCount} transações, encontrei ${targetTransactions.length}. Nada foi alterado.`
    )
  }

  const projected = new Map<string, FirebaseFirestore.DocumentData>()
  for (const doc of transactionsSnap.docs) projected.set(doc.id, { ...doc.data() })

  const changes = targetTransactions.map((doc) => {
    const data = doc.data()
    const flowType = classifyFlow(
      { amountCents: data.amountCents, description: data.descriptionRaw },
      financialProfile
    )
    const update = { flowType, ...migratedCategory(flowType, data, recategorizar) }
    projected.set(doc.id, { ...data, ...update })
    return { doc, update, financialProfile }
  })

  // A GUARDA QUE FALTAVA.
  //
  // Extrato de conta corrente passado por um perfil de cartão produz uma
  // distribuição absurda: quase tudo vira `refund`, porque toda despesa cai do
  // lado errado. Essa distribuição é a assinatura do perfil errado, e ela
  // aparece ANTES de qualquer escrita — basta olhar.
  const proporcaoDeEstorno = changes.length
    ? changes.filter(({ update }) => update.flowType === 'refund').length / changes.length
    : 0
  if (proporcaoDeEstorno > 0.5 && !process.argv.includes('--aceito-a-distribuicao')) {
    throw new Error(
      `${Math.round(proporcaoDeEstorno * 100)}% das transações viraram estorno com ` +
        `--profile=${financialProfile}. Isso é a assinatura do perfil errado: num ` +
        'extrato de verdade, estorno é exceção.\n' +
        'Confira o perfil. Se for mesmo assim, repita com --aceito-a-distribuicao. ' +
        'Nada foi alterado.'
    )
  }

  const affectedMonths = [...new Set(changes.map(({ doc }) => doc.data().month as string))].sort()
  const projectedRollups = new Map(affectedMonths.map((month) => {
    const lines: LinhaAgregavel[] = [...projected.values()]
      .filter((data) => data.month === month)
      .map((data) => ({
        month: data.month,
        amountCents: data.amountCents,
        flowType: data.flowType,
        category: data.category ?? null,
      }))
    return [month, calcularRollup(month, lines)]
  }))

  const byFlow = Object.fromEntries(
    ['expense', 'income', 'transfer', 'refund'].map((flowType) => [
      flowType,
      changes.filter(({ update }) => update.flowType === flowType).length,
    ])
  )
  const totals = Object.fromEntries([...projectedRollups].map(([month, rollup]) => [
    month,
    {
      count: rollup.count,
      incomeCents: rollup.totalInCents,
      grossExpenseCents: Math.abs(rollup.totalOutCents),
      refundCents: rollup.totalRefundCents,
      transferCents: rollup.totalTransferCents,
      netExpenseCents: totalNetExpenseCents(rollup),
    },
  ]))

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    profile: financialProfile,
    recategorizar,
    voltamParaAFila: changes.filter(({ update }) => update.category === null).length,
    projectId: process.env.FIREBASE_PROJECT_ID,
    uid: user.uid,
    email: user.email,
    filenames: [...foundNames].sort(),
    imports: imports.length,
    transactions: targetTransactions.length,
    byFlow,
    totals,
  }, null, 2))

  if (!apply) return

  const affectedAccountIds = new Set(targetTransactions.map((doc) => doc.data().accountId as string))
  const safeCardAccounts = accountsSnap.docs.filter((account) => {
    if (!affectedAccountIds.has(account.id)) return false
    return transactionsSnap.docs
      .filter((transaction) => transaction.data().accountId === account.id)
      .every((transaction) => importsById.has(transaction.data().importId))
  })

  const backupDirectory = resolve('.local-backups')
  mkdirSync(backupDirectory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = resolve(backupDirectory, `card-flow-${user.uid}-${stamp}.json`)
  writeFileSync(backupPath, JSON.stringify(plain({
    projectId: process.env.FIREBASE_PROJECT_ID,
    uid: user.uid,
    createdAt: new Date().toISOString(),
    imports: docsForBackup(imports),
    transactions: docsForBackup(targetTransactions),
    accounts: docsForBackup(accountsSnap.docs.filter((doc) => affectedAccountIds.has(doc.id))),
    rollups: docsForBackup(rollupsSnap.docs.filter((doc) => affectedMonths.includes(doc.id))),
    insights: docsForBackup(insightsSnap.docs.filter((doc) => affectedMonths.includes(doc.id))),
  })), 'utf8')

  const escritasDeOrigem: Escrita[] = [
    ...changes.map(({ doc, update }) => ({ tipo: 'update' as const, ref: doc.ref, dados: update })),
    ...imports.map((doc) => {
      const hasPending = changes.some(({ doc: transaction, update }) =>
        transaction.data().importId === doc.id && update.category === null
      )
      return {
        tipo: 'update' as const,
        ref: doc.ref,
        dados: { financialProfile, ...(hasPending ? { status: 'parsed' } : {}) },
      }
    }),
    ...safeCardAccounts.map((account) => ({
      tipo: 'update' as const,
      ref: account.ref,
      dados: { kind: 'credit_card' },
    })),
  ]

  const escritasDerivadas: Escrita[] = [...projectedRollups].flatMap(([month, rollup]) => [
    {
      tipo: 'set' as const,
      ref: db.doc(`${base}/rollups/${month}`),
      dados: { ...rollup, updatedAt: FieldValue.serverTimestamp() },
    },
    { tipo: 'delete' as const, ref: db.doc(`${base}/insights/${month}`) },
  ])

  // Um `batch` do Firestore aceita no máximo 500 operações, e a versão anterior
  // mandava TUDO num só: acima de ~490 transações de cartão a migração morria
  // no commit. Não corrompia nada — batch é tudo-ou-nada —, mas travava
  // exatamente o script que existe para consertar.
  //
  // O preço de fatiar é perder a atomicidade global, e ele é pago de propósito
  // porque as três defesas já estão de pé: o backup foi escrito antes, a
  // classificação é DETERMINÍSTICA (rodar de novo produz o mesmo `flowType`) e
  // o rollup é recalculado do mês inteiro, não somado em delta.
  //
  // A ordem é o que torna a interrupção recuperável: a ORIGEM primeiro, o
  // DERIVADO por último. Parar no meio deixa rollup velho sobre transação nova
  // — divergência que `recalcularRollup` conserta, e que o teste de deriva
  // acusa. A ordem inversa deixaria o agregado afirmando um mês que as
  // transações não sustentam, que é a corrupção silenciosa de sempre.
  await aplicarEmLotes(db, escritasDeOrigem)
  await aplicarEmLotes(db, escritasDerivadas)

  const persisted = await Promise.all(affectedMonths.map(async (month) => {
    const doc = await db.doc(`${base}/rollups/${month}`).get()
    const data = doc.data()!
    return [month, {
      count: data.count,
      incomeCents: data.totalInCents,
      grossExpenseCents: Math.abs(data.totalOutCents),
      refundCents: data.totalRefundCents,
      transferCents: data.totalTransferCents,
    }]
  }))
  console.log(JSON.stringify({ applied: true, backupPath, persisted: Object.fromEntries(persisted) }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Falha ao reparar fluxos de cartão.')
  process.exitCode = 1
})
