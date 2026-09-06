import { describe, it, expect } from 'vitest'
import {
  calcularRollup,
  deltaDeInsercao,
  deltaDeRecategorizacao,
  aplicarDelta,
  deltaSoDeCategoria,
  divergencias,
  gastoBrutoCents,
  totalNetExpenseCents,
  totalRefundCents,
  categoriasLiquidas,
  rollupVazio,
  mesDe,
  type LinhaAgregavel,
} from '@/lib/firestore/rollup'
import { CATEGORIAS } from '@/lib/domain/categories'

const AGOSTO: LinhaAgregavel[] = [
  { month: '2026-08', amountCents: 320000, category: 'receita' },
  { month: '2026-08', amountCents: -4790, category: 'alimentacao' },
  { month: '2026-08', amountCents: -800, category: 'alimentacao' },
  { month: '2026-08', amountCents: -800, category: 'alimentacao' },
  { month: '2026-08', amountCents: -150000, category: 'moradia' },
  { month: '2026-08', amountCents: -5000, category: null },
]

describe('calcularRollup', () => {
  it('separa entrada de saída e soma por categoria', () => {
    const r = calcularRollup('2026-08', AGOSTO)

    expect(r.count).toBe(6)
    expect(r.totalInCents).toBe(320000)
    expect(r.totalOutCents).toBe(-161390)
    expect(r.byCategory.alimentacao).toBe(-6390)
    expect(r.byCategory.moradia).toBe(-150000)
    expect(r.byCategory.receita).toBe(320000)
  })

  it('sempre traz as dez chaves, mesmo as zeradas', () => {
    // Categoria ausente e categoria zerada precisam ser a mesma coisa, senão
    // a pizza ganha buraco no mês em que não houve lazer.
    const r = calcularRollup('2026-08', AGOSTO)
    expect(Object.keys(r.byCategory).sort()).toEqual([...CATEGORIAS].sort())
    expect(r.byCategory.lazer).toBe(0)
  })

  it('conta transação sem categoria em `outros`', () => {
    // Assim o total do gráfico nunca fica menor que o total do extrato só
    // porque a IA ainda não rodou.
    const r = calcularRollup('2026-08', AGOSTO)
    expect(r.byCategory.outros).toBe(-5000)
  })

  it('ignora linha de outro mês', () => {
    const r = calcularRollup('2026-08', [
      ...AGOSTO,
      { month: '2026-07', amountCents: -99900, category: 'compras' },
    ])
    expect(r.count).toBe(6)
    expect(r.byCategory.compras).toBe(0)
  })

  it('a soma das fatias bate com o total, ao centavo', () => {
    // É o critério de aceite da E5, verificado aqui na aritmética antes de
    // existir gráfico nenhum.
    const r = calcularRollup('2026-08', AGOSTO)
    const soma = CATEGORIAS.reduce((acc, c) => acc + r.byCategory[c], 0)
    expect(soma).toBe(r.totalInCents + r.totalOutCents)
  })
})

describe('delta incremental', () => {
  it('inserir em duas levas dá o mesmo que calcular de uma vez', () => {
    const deUmaVez = calcularRollup('2026-08', AGOSTO)

    const emLevas = aplicarDelta(
      aplicarDelta(rollupVazio('2026-08'), deltaDeInsercao(AGOSTO.slice(0, 3))),
      deltaDeInsercao(AGOSTO.slice(3))
    )

    expect(divergencias(emLevas, deUmaVez)).toEqual([])
  })

  it('recategorizar dá exatamente o mesmo rollup que recalcular do zero', () => {
    const antes = calcularRollup('2026-08', AGOSTO)

    // A transação de -5000 sem categoria vira transporte.
    const depois = aplicarDelta(
      antes,
      deltaSoDeCategoria(deltaDeRecategorizacao(-5000, null, 'transporte'))
    )

    const esperado = calcularRollup(
      '2026-08',
      AGOSTO.map((l) =>
        l.amountCents === -5000 && l.category === null
          ? { ...l, category: 'transporte' as const }
          : l
      )
    )

    // A comparação inteira, não só os totais: é o incremental provando que
    // não diverge do recálculo, que é a razão de o rollup existir.
    expect(divergencias(depois, esperado)).toEqual([])
  })

  it('estorno reduz gasto e pagamento de fatura fica fora do resultado', () => {
    const r = calcularRollup('2026-08', [
      { month: '2026-08', amountCents: 10000, flowType: 'expense', category: 'compras' },
      { month: '2026-08', amountCents: -500, flowType: 'refund', category: 'compras' },
      { month: '2026-08', amountCents: -9500, flowType: 'transfer', category: 'outros' },
    ])

    expect(r.totalOutCents).toBe(-10000)
    expect(r.totalRefundCents).toBe(500)
    expect(r.totalTransferCents).toBe(9500)

    // `byCategory` é o BRUTO: o estorno não é abatido aqui, senão a fatia
    // deixa de somar com o total. Ele mora no mapa ao lado.
    expect(r.byCategory.compras).toBe(-10000)
    expect(r.refundByCategory.compras).toBe(500)
    expect(categoriasLiquidas(r).compras).toBe(-9500)

    // Pagamento de fatura não entra em nenhum dos dois.
    expect(r.byCategory.outros).toBe(0)
    expect(r.refundByCategory.outros).toBe(0)
  })

  it('recategorizar para a mesma categoria não gera delta', () => {
    expect(deltaDeRecategorizacao(-800, 'alimentacao', 'alimentacao')).toEqual({
      byCategory: {},
      refundByCategory: {},
    })
  })

  it('transação sem categoria sai de `outros` ao ser categorizada', () => {
    expect(deltaDeRecategorizacao(-5000, null, 'transporte')).toEqual({
      byCategory: { outros: 5000, transporte: -5000 },
      refundByCategory: {},
    })
  })
})

describe('divergencias — a defesa contra o rollup apodrecer', () => {
  it('não acusa nada quando o rollup está certo', () => {
    const real = calcularRollup('2026-08', AGOSTO)
    expect(divergencias(real, real)).toEqual([])
  })

  it('aponta a categoria e os dois valores, não só "está errado"', () => {
    const real = calcularRollup('2026-08', AGOSTO)
    const torto = {
      ...real,
      byCategory: { ...real.byCategory, alimentacao: -1 },
      count: 99,
    }

    const problemas = divergencias(torto, real)
    expect(problemas).toContain('count: guardado 99, real 6')
    expect(problemas).toContain('alimentacao: guardado -1, real -6390')
  })
})

describe('mesDe', () => {
  it('extrai YYYY-MM sem passar por Date', () => {
    // Passar por Date aqui traria fuso de volta e poderia mover a transação
    // do dia 1 para o mês anterior.
    expect(mesDe('2026-08-01')).toBe('2026-08')
    expect(mesDe('2026-12-31')).toBe('2026-12')
  })

  /**
   * O defeito que motivou separar `refundByCategory`.
   *
   * Compra de R$ 100 em alimentação e estorno de R$ 30 em eletrônicos — o caso
   * banal de comprar em agosto e a devolução cair em setembro. Com os dois
   * somados no mesmo mapa, `compras` ficava POSITIVA, a pizza (que só
   * desenha fatia negativa) descartava a categoria inteira, e o total do mês
   * subtraía aquele estorno assim mesmo: as fatias somavam 100 embaixo de um
   * card escrito 70.
   */
  it('a soma das fatias bate com o gasto bruto, mesmo com estorno sem despesa no mês', () => {
    const r = calcularRollup('2026-09', [
      { month: '2026-09', amountCents: -10000, category: 'alimentacao', flowType: 'expense' },
      { month: '2026-09', amountCents: 3000, category: 'compras', flowType: 'refund' },
    ])

    const fatias = CATEGORIAS.filter((c) => r.byCategory[c] < 0).map((c) =>
      Math.abs(r.byCategory[c])
    )
    const somaDasFatias = fatias.reduce((a, b) => a + b, 0)

    expect(somaDasFatias).toBe(gastoBrutoCents(r))
    expect(gastoBrutoCents(r)).toBe(10000)
    expect(totalRefundCents(r)).toBe(3000)
    expect(totalNetExpenseCents(r)).toBe(7000)

    // E as três leituras fecham entre si.
    expect(gastoBrutoCents(r) - totalRefundCents(r)).toBe(totalNetExpenseCents(r))
  })

  it('o estorno não contamina a fatia da categoria — ele vive no mapa dele', () => {
    const r = calcularRollup('2026-09', [
      { month: '2026-09', amountCents: -10000, category: 'alimentacao', flowType: 'expense' },
      { month: '2026-09', amountCents: 3000, category: 'alimentacao', flowType: 'refund' },
    ])

    expect(r.byCategory.alimentacao).toBe(-10000)
    expect(r.refundByCategory.alimentacao).toBe(3000)
    expect(categoriasLiquidas(r).alimentacao).toBe(-7000)
  })

  /**
   * O segundo defeito: `Math.max(0, …)` no gasto líquido.
   *
   * Num mês em que o estorno supera a compra, o card mostrava R$ 0,00 e os
   * R$ 30 que voltaram sumiam também do saldo. Mês líquido-positivo é
   * informação, não estado inválido.
   */
  it('mês em que o estorno supera a compra fica negativo, não zerado', () => {
    const r = calcularRollup('2026-09', [
      { month: '2026-09', amountCents: -5000, category: 'compras', flowType: 'expense' },
      { month: '2026-09', amountCents: 8000, category: 'compras', flowType: 'refund' },
    ])

    expect(totalNetExpenseCents(r)).toBe(-3000)
    expect(0 - totalNetExpenseCents(r)).toBe(3000)
  })

  it('recategorizar um estorno move o valor dentro de refundByCategory', () => {
    const antes = calcularRollup('2026-09', [
      { month: '2026-09', amountCents: -10000, category: 'alimentacao', flowType: 'expense' },
      { month: '2026-09', amountCents: 3000, category: 'outros', flowType: 'refund' },
    ])

    const depois = aplicarDelta(
      antes,
      deltaSoDeCategoria(deltaDeRecategorizacao(3000, 'outros', 'compras', 'refund'))
    )

    expect(depois.refundByCategory.outros).toBe(0)
    expect(depois.refundByCategory.compras).toBe(3000)
    // O gasto bruto não se mexe: recategorizar não cria nem destrói despesa.
    expect(depois.byCategory).toEqual(antes.byCategory)

    const esperado = calcularRollup('2026-09', [
      { month: '2026-09', amountCents: -10000, category: 'alimentacao', flowType: 'expense' },
      { month: '2026-09', amountCents: 3000, category: 'compras', flowType: 'refund' },
    ])
    expect(divergencias(depois, esperado)).toEqual([])
  })

  it('transferência não entra em nenhum dos dois mapas', () => {
    const r = calcularRollup('2026-09', [
      { month: '2026-09', amountCents: 300000, category: 'outros', flowType: 'transfer' },
    ])

    expect(r.byCategory.outros).toBe(0)
    expect(r.refundByCategory.outros).toBe(0)
    expect(r.totalTransferCents).toBe(300000)
    expect(gastoBrutoCents(r)).toBe(0)
  })

  it('acusa deriva no estorno por categoria, e não só no gasto', () => {
    const real = calcularRollup('2026-09', [
      { month: '2026-09', amountCents: -10000, category: 'alimentacao', flowType: 'expense' },
      { month: '2026-09', amountCents: 3000, category: 'alimentacao', flowType: 'refund' },
    ])
    const torto = {
      ...real,
      refundByCategory: { ...real.refundByCategory, alimentacao: 1 },
    }

    expect(divergencias(torto, real)).toContain(
      'refundByCategory.alimentacao: guardado 1, real 3000'
    )
  })
})
