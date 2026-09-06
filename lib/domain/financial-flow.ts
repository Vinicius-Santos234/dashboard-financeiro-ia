import type { RawTransaction } from '@/lib/sources/types'

/**
 * O sinal escrito pelo banco não tem semântica universal.
 *
 * Em conta corrente, positivo costuma ser entrada. No CSV da fatura Nubank,
 * positivo é compra e negativo é crédito/pagamento. Guardamos o valor bruto
 * para identidade e auditoria, e o tipo abaixo decide como ele participa dos
 * totais financeiros.
 */
export const FLOW_TYPES = ['expense', 'income', 'transfer', 'refund'] as const
export type FlowType = (typeof FLOW_TYPES)[number]

export const STATEMENT_PROFILES = [
  'bank_account',
  'credit_card_positive_expenses',
  'credit_card_negative_expenses',
] as const
export type StatementProfile = (typeof STATEMENT_PROFILES)[number]

export interface FlowTransaction {
  amountCents: number
  description: string
  flowType?: FlowType
}

function normalizedText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * O verbo de pagamento, e por que a lista é dessas três formas.
 *
 * `\bpagamento\b` sozinho não cobre extrato brasileiro: o Itaú escreve
 * **`PAGTO FATURA`** e o Bradesco `PAGTO. FATURA`. Abreviação é a regra, não a
 * exceção, porque a linha do extrato tem largura fixa.
 *
 * `pag` sozinho fica de FORA de propósito: `PAG*NOMEDALOJA` é como a maquininha
 * do PagSeguro aparece na fatura, e `\bpag\b` casaria com o `PAG` antes do
 * asterisco — transformando compra em pagamento de fatura.
 */
const VERBO_DE_PAGAMENTO = /\b(pagamento|pagto|pgto|payment)\b/

/**
 * O complemento. Sem ele, `PAGAMENTO` seria confundido com o nome de qualquer
 * estabelecimento que comece por essa palavra.
 */
const COMPLEMENTO_DE_PAGAMENTO =
  /\b(recebido|received|fatura|invoice|cartao|card|efetuado|realizado|online|on line|obrigado|thank you)\b/

/**
 * Pagamento da fatura é transferência entre contas, não renda nem gasto.
 *
 * Aceita as três formas em que ele aparece de verdade:
 *
 *   - verbo + complemento — `PAGTO FATURA`, `Pagamento recebido`,
 *     `PAYMENT - THANK YOU`;
 *   - o verbo sozinho ocupando a linha inteira — `PAGAMENTO`, que alguns
 *     bancos usam sem qualificar nada;
 *   - `ESTORNO` fica de fora deliberadamente: estorno **é** `refund`, e
 *     confundir os dois some com dinheiro que voltou.
 */
export function isCardPayment(description: string): boolean {
  const text = normalizedText(description)
  if (!VERBO_DE_PAGAMENTO.test(text)) return false
  return COMPLEMENTO_DE_PAGAMENTO.test(text) || /^(pagamento|pagto|pgto|payment)\.?$/.test(text)
}

/**
 * Movimento INTERNO de conta corrente: o dinheiro muda de lugar, não some nem
 * aparece.
 *
 * Isto existe porque a versão anterior tratava conta corrente como se todo
 * negativo fosse gasto e todo positivo fosse renda, e num extrato real isso é
 * grosseiramente falso. Medido no extrato que motivou a correção: **87% dos
 * "gastos" não eram gasto** — R$ 1.622 de fatura de cartão e R$ 432 de
 * aplicação, contra R$ 307 de despesa de verdade. Do outro lado, R$ 279 de
 * "receita" era resgate de investimento e Pix no crédito.
 *
 * Cada padrão aqui é inequívoco. O que é ambíguo fica **de fora** de
 * propósito:
 *
 *   - **Pix enviado a uma pessoa continua despesa.** Pagar o aluguel por Pix é
 *     gasto; mandar dinheiro para a própria conta não é. O extrato não
 *     distingue, e chutar "transferência" esconderia gasto real — errar para
 *     menos é o lado que ninguém audita.
 *   - **Boleto continua despesa.** `PAGAMENTO DE BOLETO` é conta paga, não
 *     movimentação interna, e é por isso que este predicado não reaproveita o
 *     `isCardPayment`, que é mais frouxo por viver num contexto onde só há
 *     fatura.
 */
const MOVIMENTOS_INTERNOS: readonly RegExp[] = [
  // Fatura do cartão paga pela conta. Sem isto ela vira o maior "gasto" do
  // mês, somado POR CIMA das compras que ela quita.
  /\b(pagamento|pagto|pgto) (de )?fatura\b/,
  // Dinheiro indo para investimento e voltando dele.
  /^aplicacao\b/,
  /^resgate\b/,
  // "Pix no crédito": entra na conta vindo do cartão e sai no mesmo instante.
  // Contado como receita, inflava a entrada do mês sem nada ter entrado.
  /valor adicionado na conta por cartao de credito/,
]

export function isInternalMovement(description: string): boolean {
  const text = normalizedText(description)
  return MOVIMENTOS_INTERNOS.some((padrao) => padrao.test(text))
}

export function classifyFlow(
  transaction: Pick<RawTransaction, 'amountCents' | 'description'>,
  profile: StatementProfile
): FlowType {
  if (profile === 'bank_account') {
    if (isInternalMovement(transaction.description)) return 'transfer'
    return transaction.amountCents >= 0 ? 'income' : 'expense'
  }

  const expenseIsPositive = profile === 'credit_card_positive_expenses'
  const isExpense = expenseIsPositive
    ? transaction.amountCents >= 0
    : transaction.amountCents <= 0

  // A DIREÇÃO decide antes da descrição, e essa ordem é a proteção.
  //
  // A versão anterior perguntava `isCardPayment` primeiro, então um falso
  // positivo do texto tirava uma COMPRA de dentro dos gastos. Agora o texto só
  // é consultado do lado do crédito, onde o pagamento de fatura de fato cai —
  // e o pior que um falso positivo faz é trocar `refund` por `transfer`, dois
  // lançamentos que já não entram como gasto.
  if (isExpense) return 'expense'

  return isCardPayment(transaction.description) ? 'transfer' : 'refund'
}

export function classifyTransactions(
  transactions: readonly RawTransaction[],
  profile: StatementProfile
): RawTransaction[] {
  return transactions.map((transaction) => ({
    ...transaction,
    flowType: classifyFlow(transaction, profile),
  }))
}

/** Compatibilidade com documentos gravados antes de `flowType` existir. */
export function resolvedFlowType(
  transaction: Pick<FlowTransaction, 'amountCents' | 'flowType'>
): FlowType {
  return transaction.flowType ?? (transaction.amountCents >= 0 ? 'income' : 'expense')
}

/** Valor com a semântica exibida na lista. Transferência fica neutra e positiva. */
export function displayAmountCents(transaction: FlowTransaction): number {
  const amount = Math.abs(transaction.amountCents)
  return resolvedFlowType(transaction) === 'expense' ? -amount : amount
}

/**
 * Contribuição para a categoria. Estorno reduz o gasto; transferência não
 * entra no gráfico; receita continua positiva na sua categoria própria.
 */
export function categoryAmountCents(transaction: FlowTransaction): number {
  const amount = Math.abs(transaction.amountCents)
  switch (resolvedFlowType(transaction)) {
    case 'expense': return -amount
    case 'income': return amount
    case 'refund': return amount
    case 'transfer': return 0
  }
}

/** Para a IA, estorno precisa carregar a categoria da despesa que ele reduz. */
export function categorizationAmountCents(transaction: FlowTransaction): number {
  const amount = Math.abs(transaction.amountCents)
  const flowType = resolvedFlowType(transaction)
  if (flowType === 'income') return amount
  if (flowType === 'transfer') return 0
  return -amount
}

export interface FlowSummary {
  count: number
  expenseCount: number
  incomeCount: number
  transferCount: number
  refundCount: number
  grossExpenseCents: number
  incomeCents: number
  transferCents: number
  refundCents: number
  netExpenseCents: number
}

export function summarizeFlows(transactions: readonly FlowTransaction[]): FlowSummary {
  const summary: FlowSummary = {
    count: 0,
    expenseCount: 0,
    incomeCount: 0,
    transferCount: 0,
    refundCount: 0,
    grossExpenseCents: 0,
    incomeCents: 0,
    transferCents: 0,
    refundCents: 0,
    netExpenseCents: 0,
  }

  for (const transaction of transactions) {
    const amount = Math.abs(transaction.amountCents)
    summary.count += 1
    switch (resolvedFlowType(transaction)) {
      case 'expense':
        summary.expenseCount += 1
        summary.grossExpenseCents += amount
        break
      case 'income':
        summary.incomeCount += 1
        summary.incomeCents += amount
        break
      case 'transfer':
        summary.transferCount += 1
        summary.transferCents += amount
        break
      case 'refund':
        summary.refundCount += 1
        summary.refundCents += amount
        break
    }
  }

  summary.netExpenseCents = Math.max(
    0,
    summary.grossExpenseCents - summary.refundCents
  )
  return summary
}

/**
 * A descrição sobrou sem sinal nenhum depois do anonimizador?
 *
 * `Transferência enviada pelo Pix - FULANO - •••.123.456-•• - BANCO ...` vira
 * exatamente **`"Transferência"`**, porque a contraparte é dado pessoal e sai
 * antes de qualquer chamada à IA (spec §6). O que chega ao modelo é uma
 * palavra — e uma palavra não tem como virar categoria.
 *
 * Mandar isso para a LLM é gastar chamada paga para receber `outros`, que já
 * se sabia de antemão. No extrato que motivou a correção eram **9 das 16
 * despesas**. A resposta é a mesma; o custo, não.
 */
const SEM_SINAL = new Set([
  'transferencia',
  'transferencia enviada',
  'transferencia recebida',
  'pix',
  'pix enviado',
  'pix recebido',
  'debito em conta',
  'credito em conta',
  'debito',
  'credito',
])

export function semSinalParaCategorizar(descriptionClean: string): boolean {
  return SEM_SINAL.has(normalizedText(descriptionClean).replace(/[.\-]+$/, ''))
}
