import { describe, it, expect } from 'vitest'
import {
  calcularRollup,
  deltaDeInsercao,
  deltaDeRecategorizacao,
  aplicarDelta,
  divergencias,
  rollupVazio,
  porCategoriaVazio,
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
    const depois = aplicarDelta(antes, {
      totalInCents: 0,
      totalOutCents: 0,
      count: 0,
      byCategory: {
        ...porCategoriaVazio(),
        ...deltaDeRecategorizacao(-5000, null, 'transporte'),
      },
    })

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

  it('recategorizar para a mesma categoria não gera delta', () => {
    expect(deltaDeRecategorizacao(-800, 'alimentacao', 'alimentacao')).toEqual({})
  })

  it('transação sem categoria sai de `outros` ao ser categorizada', () => {
    expect(deltaDeRecategorizacao(-5000, null, 'transporte')).toEqual({
      outros: 5000,
      transporte: -5000,
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
})
