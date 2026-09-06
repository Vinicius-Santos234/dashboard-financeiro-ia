import { describe, expect, it } from 'vitest'
import {
  classifyFlow,
  classifyTransactions,
  displayAmountCents,
  isCardPayment,
  isInternalMovement,
  semSinalParaCategorizar,
  summarizeFlows,
} from '@/lib/domain/financial-flow'

const nubank = [
  { occurredOn: '2026-08-01', amountCents: 5000, description: 'COMPRA A' },
  { occurredOn: '2026-08-02', amountCents: 1030, description: 'COMPRA B' },
  { occurredOn: '2026-08-03', amountCents: -5900, description: 'Pagamento recebido' },
  { occurredOn: '2026-08-04', amountCents: -100, description: 'Estorno COMPRA A' },
]

describe('semântica financeira do extrato', () => {
  it('interpreta o CSV de cartão com compra positiva sem alterar o valor bruto', () => {
    const transacoes = classifyTransactions(
      nubank,
      'credit_card_positive_expenses'
    )

    expect(transacoes.map((t) => t.flowType)).toEqual([
      'expense',
      'expense',
      'transfer',
      'refund',
    ])
    expect(transacoes.map((t) => t.amountCents)).toEqual([5000, 1030, -5900, -100])
    expect(displayAmountCents(transacoes[0])).toBe(-5000)
  })

  it('separa compras, pagamentos e estornos na prévia', () => {
    const resumo = summarizeFlows(
      classifyTransactions(nubank, 'credit_card_positive_expenses')
    )

    expect(resumo).toMatchObject({
      count: 4,
      expenseCount: 2,
      transferCount: 1,
      refundCount: 1,
      grossExpenseCents: 6030,
      transferCents: 5900,
      refundCents: 100,
      netExpenseCents: 5930,
    })
  })

  it('interpreta OFX de cartão com débitos negativos', () => {
    const transacoes = classifyTransactions(
      [
        { occurredOn: '2026-07-01', amountCents: -4290, description: 'COMPRA' },
        { occurredOn: '2026-07-02', amountCents: 127786, description: 'Pagamento recebido' },
      ],
      'credit_card_negative_expenses'
    )

    expect(transacoes.map((t) => t.flowType)).toEqual(['expense', 'transfer'])
  })

  it('mantém a convenção de conta bancária', () => {
    const transacoes = classifyTransactions(
      [
        { occurredOn: '2026-08-01', amountCents: 300000, description: 'SALARIO' },
        { occurredOn: '2026-08-02', amountCents: -5000, description: 'MERCADO' },
      ],
      'bank_account'
    )

    expect(transacoes.map((t) => t.flowType)).toEqual(['income', 'expense'])
  })

  /**
   * O achado: `\bpagamento\b` não cobre extrato brasileiro.
   *
   * O Itaú escreve `PAGTO FATURA` — e como a regra anterior exigia a palavra
   * inteira, o pagamento da fatura caía em `refund`. Isso é PIOR que ficar sem
   * classificação: estorno **reduz** o gasto do mês, então uma fatura de
   * R$ 3.000 paga sumia R$ 3.000 do total gasto.
   */
  it.each([
    'Pagamento recebido',
    'PAGTO FATURA',
    'PAGTO. FATURA',
    'PGTO FATURA',
    'PAGAMENTO DE FATURA',
    'Pagamento efetuado',
    'PAGAMENTO ON LINE',
    'PAGAMENTO',
    'PAYMENT - THANK YOU',
    'Payment received',
    'CARD PAYMENT',
  ])('reconhece %s como pagamento de fatura, não como estorno', (description) => {
    expect(isCardPayment(description)).toBe(true)

    // Nos dois perfis, e sempre do lado do crédito.
    expect(
      classifyFlow({ amountCents: -15000, description }, 'credit_card_positive_expenses')
    ).toBe('transfer')
    expect(
      classifyFlow({ amountCents: 15000, description }, 'credit_card_negative_expenses')
    ).toBe('transfer')
  })

  /** Estorno não é pagamento: confundir os dois some com dinheiro que voltou. */
  it.each(['Estorno de compra', 'ESTORNO IFOOD', 'Reembolso'])(
    '%s continua sendo estorno',
    (description) => {
      expect(isCardPayment(description)).toBe(false)
      expect(
        classifyFlow({ amountCents: 15000, description }, 'credit_card_negative_expenses')
      ).toBe('refund')
    }
  )

  /**
   * A proteção contra o falso positivo, que aqui é a parte cara.
   *
   * `PAG*LOJA` é como a maquininha do PagSeguro aparece na fatura. Se o texto
   * fosse consultado antes da direção, uma COMPRA viraria transferência e
   * sairia dos gastos — o inverso do defeito acima, e mais difícil de notar.
   */
  it.each([
    'PAG*LOJA DO ZE',
    'PAGSEGURO *MERCADO',
    'PAGAMENTO EXPRESS LTDA',
    'Supermercado Pagamento Facil',
  ])('%s é compra, mesmo parecendo pagamento', (description) => {
    expect(
      classifyFlow({ amountCents: 15000, description }, 'credit_card_positive_expenses')
    ).toBe('expense')
    expect(
      classifyFlow({ amountCents: -15000, description }, 'credit_card_negative_expenses')
    ).toBe('expense')
  })

  /**
   * O extrato que revelou o buraco: uma conta Nubank usada como canal de Pix e
   * de investimento, sem uma única compra. Tratar todo negativo como gasto
   * fazia **87% dos "gastos" não serem gasto** — R$ 1.622 de fatura de cartão
   * e R$ 432 de aplicação, contra R$ 307 de despesa de verdade.
   */
  it.each([
    ['Pagamento de fatura', -151617],
    ['PAGTO FATURA', -10591],
    ['Aplicação RDB', -20000],
    ['Aplicação Fundo - Itaú Gold Distribuidores Multimercado FIF CIC - Resp. Ltda', -10000],
    ['Resgate RDB', 12000],
    ['Valor adicionado na conta por cartão de crédito - Valor adicionado para Pix no Crédito', 2500],
  ])('em conta corrente, %s é movimentação interna e não entra no resultado', (description, amountCents) => {
    expect(isInternalMovement(description)).toBe(true)
    expect(classifyFlow({ amountCents, description }, 'bank_account')).toBe('transfer')
  })

  /**
   * O outro lado, e é o que mantém a correção honesta: o ambíguo fica de fora.
   * Chutar "transferência" em Pix enviado esconderia gasto real — errar para
   * menos é o lado que ninguém audita.
   */
  it.each([
    ['Transferência enviada pelo Pix - César Henrique Giacomino', -2500, 'expense'],
    ['PAGAMENTO DE BOLETO', -8000, 'expense'],
    ['SUPERMERCADO EXTRA', -12000, 'expense'],
    ['Débito em conta', -1299, 'expense'],
    ['Transferência recebida pelo Pix - JMV SERVICOS', 149943, 'income'],
    ['SALARIO EMPRESA', 300000, 'income'],
  ])('%s continua sendo %s em conta corrente', (description, amountCents, esperado) => {
    expect(isInternalMovement(description)).toBe(false)
    expect(classifyFlow({ amountCents, description }, 'bank_account')).toBe(esperado)
  })

  /**
   * `Transferência enviada pelo Pix - FULANO - •••.123.456-•• - BANCO` vira
   * exatamente `"Transferência"` depois do anonimizador. Mandar isso à LLM é
   * pagar por uma resposta que já se conhece — eram 9 das 16 despesas.
   */
  it.each(['Transferência', 'Débito em conta', 'Crédito em conta', 'Pix', 'PIX ENVIADO'])(
    '%s não tem sinal para categorizar e não vai à IA',
    (clean) => expect(semSinalParaCategorizar(clean)).toBe(true)
  )

  it.each(['IFD*IFOOD SAO PAULO', 'Aplicação RDB', 'SUPERMERCADO EXTRA', 'Pagamento de fatura'])(
    '%s tem sinal e continua indo à IA',
    (clean) => expect(semSinalParaCategorizar(clean)).toBe(false)
  )
})
