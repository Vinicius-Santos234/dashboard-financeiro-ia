import { describe, it, expect } from 'vitest'
import {
  diaDeFechamentoValido,
  fechamentoSugerido,
  intervaloDaFatura,
  periodoDaFatura,
} from '@/lib/domain/invoice'
import {
  origemDaContagem,
  origemDasContas,
  contagemPorTipoVazia,
} from '@/lib/domain/account'
import {
  DIAS_PARA_RENDA_ENVELHECER,
  diasDesde,
  percentualDaRenda,
} from '@/lib/domain/renda'
import { categoriaAposFluxo, perfilSugerido } from '@/lib/domain/financial-flow'
import { encontrarRegra, fluxoDaRegra } from '@/lib/domain/rules'
import { mesCurto } from '@/lib/domain/month'
import {
  aplicarDelta,
  calcularRollup,
  deltaDeInsercao,
  deltaDeMudancaDeFluxo,
  divergencias,
  gastoBrutoCents,
  totalNetExpenseCents,
  totalRefundCents,
  origemDoRollup,
  rollupVazio,
  type LinhaAgregavel,
} from '@/lib/firestore/rollup'

/**
 * Spec 003 §8 C8 — a fatura como unidade de período.
 */
describe('a qual fatura pertence uma compra', () => {
  it('o critério de aceite: 28/09 numa fatura que fecha em 03/10 vai para outubro', () => {
    expect(periodoDaFatura('2026-09-28', 3)).toBe('2026-10')
  })

  it('no dia do fechamento, ainda entra na fatura que fecha neste mês', () => {
    expect(periodoDaFatura('2026-10-03', 3)).toBe('2026-10')
  })

  it('um dia depois do fechamento já é a próxima fatura', () => {
    expect(periodoDaFatura('2026-10-04', 3)).toBe('2026-11')
  })

  it('vira o ano corretamente', () => {
    expect(periodoDaFatura('2026-12-20', 3)).toBe('2027-01')
    expect(periodoDaFatura('2026-12-02', 3)).toBe('2026-12')
  })

  it('sem fechamento configurado, o período continua sendo o mês civil', () => {
    expect(periodoDaFatura('2026-09-28', null)).toBe('2026-09')
    expect(periodoDaFatura('2026-12-31', null)).toBe('2026-12')
  })

  it('a soma das faturas bate com a soma das transações do ano', () => {
    // O outro lado do critério de aceite da C8: reparticionar não cria nem
    // destrói dinheiro, só muda de qual fatura cada compra faz parte.
    const dias = [
      '2026-01-15', '2026-02-02', '2026-02-28', '2026-03-10', '2026-05-04',
      '2026-07-03', '2026-08-29', '2026-11-30', '2026-12-31',
    ]
    const porFatura = new Map<string, number>()
    for (const dia of dias) {
      const periodo = periodoDaFatura(dia, 3)
      porFatura.set(periodo, (porFatura.get(periodo) ?? 0) + 100)
    }

    const somaDasFaturas = [...porFatura.values()].reduce((a, b) => a + b, 0)
    expect(somaDasFaturas).toBe(dias.length * 100)
  })

  it('o intervalo coberto por uma fatura', () => {
    expect(intervaloDaFatura('2026-10', 3)).toEqual({
      de: '2026-09-04',
      ate: '2026-10-03',
    })
  })

  it('recusa dia fora de 1 a 28, porque 29 a 31 não existem todo mês', () => {
    expect(diaDeFechamentoValido(1)).toBe(true)
    expect(diaDeFechamentoValido(28)).toBe(true)
    expect(diaDeFechamentoValido(0)).toBe(false)
    expect(diaDeFechamentoValido(29)).toBe(false)
    expect(diaDeFechamentoValido(31)).toBe(false)
    expect(diaDeFechamentoValido('3')).toBe(false)
  })

  it('sugere o fechamento a partir do DTEND do arquivo', () => {
    expect(fechamentoSugerido('2026-10-03')).toBe(3)
    // Dia 31 não serve como fechamento recorrente.
    expect(fechamentoSugerido('2026-10-31')).toBe(null)
    expect(fechamentoSugerido(null)).toBe(null)
  })

  it('CSV não declara fechamento, então não sugere nenhum', async () => {
    /**
     * A regressão que este teste tranca.
     *
     * `periodEnd` de um CSV é a data da ÚLTIMA COMPRA, não um fechamento.
     * Numa fatura Nubank que fecha dia 13 com última compra dia 3, usar
     * `periodEnd` configurava fechamento no dia 3 — e a partir daí cada
     * importação reparticionava tudo em torno de uma data inventada, jogando
     * lançamentos em meses que ninguém importou.
     */
    const { inspecionar, csvAdapter } = await import('@/lib/sources/csv')
    const csv = [
      'date,title,amount',
      '2026-08-03,Padaria,"38,80"',
      '2026-07-06,Mercado,"120,00"',
    ].join('\n')

    const insp = inspecionar(csv)
    const lido = await csvAdapter.parse(csv, {
      colunaData: 'date',
      colunaDescricao: 'title',
      colunaValor: 'amount',
      formatoData: 'yyyy-mm-dd',
    })

    // O período observado existe e termina na última compra…
    expect(lido.periodEnd).toBe('2026-08-03')
    // …mas fechamento declarado, não. E é dele que a sugestão sai.
    expect(lido.closingDate).toBeUndefined()
    expect(fechamentoSugerido(lido.closingDate)).toBe(null)
    expect(insp.totalLinhas).toBe(2)
  })

  it('OFX de cartão com DTEND declara o fechamento; sem DTEND, não', async () => {
    const { ofxAdapter } = await import('@/lib/sources/ofx')
    const { readFileSync } = await import('node:fs')
    const bytes = readFileSync('tests/fixtures/derivadas/fatura-demo.ofx')
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer

    const lido = await ofxAdapter.parse(buf, undefined)
    // A fixture declara <DTEND>20260731 num CCSTMTRS.
    expect(lido.closingDate).toBe('2026-07-31')
    // …e 31 não serve como fechamento recorrente, então nem assim sugere.
    expect(fechamentoSugerido(lido.closingDate)).toBe(null)
  })
})

/**
 * Spec 003 §8 C1 — o app deixa de perguntar a convenção de sinal.
 */
describe('o perfil que o próprio arquivo sugere', () => {
  it('fatura comum: compras dominam, e o sinal delas é negativo', () => {
    // 18 compras, 1 pagamento, 1 estorno — a forma de uma fatura de verdade.
    expect(perfilSugerido({ positivos: 2, negativos: 18 })).toBe(
      'credit_card_negative_expenses'
    )
  })

  it('fatura Nubank: mesma forma, sinal invertido', () => {
    expect(perfilSugerido({ positivos: 18, negativos: 2 })).toBe(
      'credit_card_positive_expenses'
    )
  })

  it('tudo de um sinal só decide sem hesitar', () => {
    expect(perfilSugerido({ positivos: 0, negativos: 7 })).toBe(
      'credit_card_negative_expenses'
    )
    expect(perfilSugerido({ positivos: 7, negativos: 0 })).toBe(
      'credit_card_positive_expenses'
    )
  })

  it('empate não vira chute — a tela pergunta', () => {
    // Errar aqui inverte TODOS os números do mês. Perto de 50% o arquivo
    // provavelmente nem é uma fatura, e a pergunta passa a ser honesta.
    expect(perfilSugerido({ positivos: 10, negativos: 10 })).toBe(null)
    expect(perfilSugerido({ positivos: 11, negativos: 9 })).toBe(null)
  })

  it('arquivo sem valor legível não sugere nada', () => {
    expect(perfilSugerido({ positivos: 0, negativos: 0 })).toBe(null)
  })

  it('o limiar é 60%, e ele é conferido nos dois lados', () => {
    // 12/20 = 60% → decide. 11/20 = 55% → não.
    expect(perfilSugerido({ positivos: 8, negativos: 12 })).toBe(
      'credit_card_negative_expenses'
    )
    expect(perfilSugerido({ positivos: 9, negativos: 11 })).toBe(null)
  })
})

/**
 * O rótulo curto de mês, que existe por causa de um recorte errado.
 */
describe('rótulo curto de mês', () => {
  it('tem a mesma forma em todos os meses', () => {
    // O defeito que isto fecha: cortar `mesLegivel` por número de caracteres
    // produzia `agosto/2` ao lado de `maio/202` — recorte arbitrário, que se
    // lê como um ano quebrado.
    expect(mesCurto('2026-04')).toBe('abr/26')
    expect(mesCurto('2026-05')).toBe('mai/26')
    expect(mesCurto('2026-08')).toBe('ago/26')
    expect(mesCurto('2026-09')).toBe('set/26')
    expect(mesCurto('2027-01')).toBe('jan/27')
  })

  it('todo mês do ano cabe em 7 caracteres', () => {
    for (let m = 1; m <= 12; m += 1) {
      const rotulo = mesCurto(`2026-${String(m).padStart(2, '0')}`)
      expect(rotulo.length).toBeLessThanOrEqual(7)
      expect(rotulo).toMatch(/^[a-z]{3}\/\d{2}$/)
    }
  })
})

/**
 * Spec 003 §5 D3 — cartão não tem saldo.
 */
describe('a origem que a tela obedece', () => {
  it('só cartão é fatura', () => {
    expect(origemDaContagem({ ...contagemPorTipoVazia(), credit_card: 12 })).toBe('fatura')
  })

  it('basta uma linha de conta corrente para o mês ter saldo', () => {
    expect(
      origemDaContagem({ checking: 1, savings: 0, credit_card: 40 })
    ).toBe('conta')
  })

  it('poupança também é conta', () => {
    expect(origemDaContagem({ checking: 0, savings: 3, credit_card: 0 })).toBe('conta')
  })

  it('mês vazio não sabe, e não chuta', () => {
    expect(origemDaContagem(contagemPorTipoVazia())).toBe(null)
  })

  it('sem conta nenhuma cadastrada, o padrão é fatura — a proposta do produto', () => {
    expect(origemDasContas([])).toBe('fatura')
  })

  it('quem tem conta corrente continua vendo os números de conta', () => {
    expect(origemDasContas([{ kind: 'checking' }, { kind: 'credit_card' }])).toBe('conta')
    expect(origemDasContas([{ kind: 'credit_card' }])).toBe('fatura')
  })
})

/**
 * Spec 003 §7 e §8 C3 — `null` não é zero.
 */
describe('o percentual da renda', () => {
  it('bate ao centavo com gastoLiquido / rendaMensalCents', () => {
    expect(percentualDaRenda(176_170, 650_000)).toBeCloseTo(27.1031, 4)
    expect(percentualDaRenda(325_000, 650_000)).toBe(50)
  })

  it('sem renda informada, não existe percentual — nem 0%, nem 100%', () => {
    expect(percentualDaRenda(176_170, null)).toBe(null)
  })

  it('renda zerada cai no mesmo caminho da ausente, e nunca vira Infinity', () => {
    expect(percentualDaRenda(176_170, 0)).toBe(null)
    expect(percentualDaRenda(176_170, -1)).toBe(null)
  })

  it('renda apagada volta ao primeiro estado, sem resíduo', () => {
    const comRenda = percentualDaRenda(100_000, 500_000)
    const apagada = percentualDaRenda(100_000, null)
    expect(comRenda).toBe(20)
    expect(apagada).toBe(null)
  })

  it('conta desde quando a renda vale', () => {
    const agora = new Date('2026-09-19T12:00:00Z')
    expect(diasDesde('2026-09-19T12:00:00Z', agora)).toBe(0)
    expect(diasDesde('2026-09-09T12:00:00Z', agora)).toBe(10)
    expect(diasDesde('2026-01-01T12:00:00Z', agora)).toBeGreaterThan(
      DIAS_PARA_RENDA_ENVELHECER
    )
  })
})

/**
 * Spec 003 §5 D5 e §8 C5 — o fluxo corrigível, e as três leituras fechando.
 */
describe('corrigir o fluxo de uma linha', () => {
  const base: LinhaAgregavel = {
    month: '2026-09',
    amountCents: -25_000,
    category: 'compras',
    accountKind: 'credit_card',
  }

  const fatura: LinhaAgregavel[] = [
    { month: '2026-09', amountCents: -10_000, category: 'alimentacao', flowType: 'expense', accountKind: 'credit_card' },
    { month: '2026-09', amountCents: -25_000, category: 'compras', flowType: 'expense', accountKind: 'credit_card' },
    { month: '2026-09', amountCents: 5_000, category: 'alimentacao', flowType: 'refund', accountKind: 'credit_card' },
  ]

  it('de compra para estorno: as três leituras continuam fechando', () => {
    const antes = calcularRollup('2026-09', fatura)
    const depois = aplicarDelta(
      antes,
      deltaDeMudancaDeFluxo(
        { ...base, flowType: 'expense' },
        { ...base, flowType: 'refund' }
      )
    )

    expect(
      gastoBrutoCents(depois) - totalRefundCents(depois)
    ).toBe(totalNetExpenseCents(depois))

    // E bate campo a campo com o recálculo do zero, que é o critério de aceite.
    const recalculado = calcularRollup('2026-09', [
      fatura[0],
      { ...base, flowType: 'refund' },
      fatura[2],
    ])
    expect(divergencias(depois, recalculado)).toEqual([])
  })

  it('de compra para transferência: sai dos gastos e entra no próprio total', () => {
    const antes = calcularRollup('2026-09', fatura)
    const depois = aplicarDelta(
      antes,
      deltaDeMudancaDeFluxo(
        { ...base, flowType: 'expense' },
        { ...base, category: 'outros', flowType: 'transfer' }
      )
    )

    expect(depois.totalTransferCents).toBe(25_000)
    expect(gastoBrutoCents(depois)).toBe(10_000)
    expect(depois.byCategory.compras).toBe(0)

    const recalculado = calcularRollup('2026-09', [
      fatura[0],
      { ...base, category: 'outros', flowType: 'transfer' },
      fatura[2],
    ])
    expect(divergencias(depois, recalculado)).toEqual([])
  })

  it('não mexe na contagem: a transação não deixou de existir', () => {
    const delta = deltaDeMudancaDeFluxo(
      { ...base, flowType: 'expense' },
      { ...base, flowType: 'transfer' }
    )
    expect(delta.count).toBe(0)
  })

  it('voltar atrás devolve exatamente o rollup original', () => {
    const antes = calcularRollup('2026-09', fatura)
    const ida = aplicarDelta(
      antes,
      deltaDeMudancaDeFluxo({ ...base, flowType: 'expense' }, { ...base, flowType: 'transfer' })
    )
    const volta = aplicarDelta(
      ida,
      deltaDeMudancaDeFluxo({ ...base, flowType: 'transfer' }, { ...base, flowType: 'expense' })
    )
    expect(divergencias(volta, antes)).toEqual([])
  })
})

/**
 * Spec 003 §5 D5 — a correção vira regra, aplicada no import.
 */
describe('regra de fluxo', () => {
  const regras = [
    { pattern: 'CONDOMINIO', category: 'moradia' as const, hits: 2, flowType: 'expense' as const },
    { pattern: 'IFOOD', category: 'alimentacao' as const, hits: 9 },
  ]

  it('impõe o fluxo que a pessoa corrigiu', () => {
    expect(fluxoDaRegra('PAG*CONDOMINIO EDIFICIO', regras)).toBe('expense')
  })

  it('regra só de categoria não tem opinião sobre fluxo', () => {
    expect(fluxoDaRegra('IFD*IFOOD SAO PAULO', regras)).toBe(null)
  })

  it('descrição que não casa com nada não muda fluxo nenhum', () => {
    expect(fluxoDaRegra('PADARIA BELA VISTA', regras)).toBe(null)
  })

  it('regra só de fluxo impõe o tipo mas NÃO categoriza', () => {
    // O defeito que isto evita: se uma correção só de fluxo criasse a regra
    // com `outros`, toda linha que casasse com o padrão entraria em `outros`
    // pela regra — e sairia da fila da IA para sempre, porque `category`
    // deixar de ser nulo é irreversível pelo caminho normal.
    const soFluxo = [
      { pattern: 'MAQUININHA', category: null, hits: 0, flowType: 'expense' as const },
    ]

    expect(fluxoDaRegra('PAG*MAQUININHA LTDA', soFluxo)).toBe('expense')
    expect(encontrarRegra('PAG*MAQUININHA LTDA', soFluxo)).toBe(null)
  })

  it('regra com categoria continua categorizando normalmente', () => {
    expect(encontrarRegra('IFD*IFOOD SAO PAULO', regras)?.category).toBe('alimentacao')
  })
})

/**
 * Spec 003 §8 C2 — a contagem por tipo entra no rollup e sobrevive ao delta.
 */
describe('a origem viaja no rollup', () => {
  it('a inserção conta as transações por tipo de conta', () => {
    const delta = deltaDeInsercao([
      { month: '2026-09', amountCents: -100, category: null, accountKind: 'credit_card' },
      { month: '2026-09', amountCents: -200, category: null, accountKind: 'credit_card' },
      { month: '2026-09', amountCents: -300, category: null, accountKind: 'checking' },
    ])
    expect(delta.byAccountKind).toEqual({ checking: 1, savings: 0, credit_card: 2 })
  })

  it('linha legada sem tipo não conta para origem nenhuma', () => {
    const delta = deltaDeInsercao([
      { month: '2026-09', amountCents: -100, category: null },
    ])
    expect(delta.byAccountKind).toEqual(contagemPorTipoVazia())
  })

  it('o delta soma sobre o rollup vazio sem perder a contagem', () => {
    const r = aplicarDelta(
      rollupVazio('2026-09'),
      deltaDeInsercao([
        { month: '2026-09', amountCents: -100, category: null, accountKind: 'credit_card' },
      ])
    )
    expect(r.byAccountKind.credit_card).toBe(1)
  })

  it('a divergência denuncia contagem por tipo fora do lugar', () => {
    const real = calcularRollup('2026-09', [
      { month: '2026-09', amountCents: -100, category: null, accountKind: 'credit_card' },
    ])
    const mentiroso = { ...real, byAccountKind: contagemPorTipoVazia() }
    expect(divergencias(mentiroso, real)).toContain(
      'byAccountKind.credit_card: guardado 0, real 1'
    )
  })
})

/**
 * Regressões dos achados da revisão externa de 19/09.
 *
 * Cada `it` aqui reproduz um caminho que uma revisão de fora encontrou e que
 * nenhuma camada automática pegava — typecheck, lint e a suíte estavam todos
 * verdes enquanto os defeitos existiam.
 */
describe('regressões da revisão de 19/09', () => {
  it('#6 contagem por tipo parcial não decide a origem', () => {
    // Rollup legado (contagem zerada) que recebeu UMA linha de cartão nova:
    // count=2, mas byAccountKind só conhece 1. Decidir por essa contagem
    // devolveria `fatura` e sumiria com a receita da conta corrente.
    const parcial = {
      ...rollupVazio('2026-09'),
      count: 2,
      byAccountKind: { checking: 0, savings: 0, credit_card: 1 },
    }
    expect(origemDoRollup(parcial)).toBe(null)

    // Cobrindo o período inteiro, ela volta a valer.
    const completo = {
      ...rollupVazio('2026-09'),
      count: 2,
      byAccountKind: { checking: 0, savings: 0, credit_card: 2 },
    }
    expect(origemDoRollup(completo)).toBe('fatura')
  })

  it('#8 regra de receita não categoriza compra nem estorno', () => {
    const regras = [{ pattern: 'MERCADO', category: 'receita' as const, hits: 3 }]

    // A pizza exclui `receita`: aplicar isto a uma compra tirava o valor das
    // fatias sem tirar do total.
    expect(encontrarRegra('MERCADO EXTRA', regras, 'expense')).toBe(null)
    expect(encontrarRegra('MERCADO EXTRA', regras, 'refund')).toBe(null)
    // E continua valendo onde faz sentido.
    expect(encontrarRegra('MERCADO EXTRA', regras, 'income')?.category).toBe('receita')
  })

  it('#8 regra de gasto não se aplica a entrada', () => {
    const regras = [{ pattern: 'SALARIO', category: 'alimentacao' as const, hits: 1 }]
    expect(encontrarRegra('SALARIO MENSAL', regras, 'income')).toBe(null)
    expect(encontrarRegra('SALARIO MENSAL', regras, 'expense')?.category).toBe('alimentacao')
  })

  it('#9 sair de transferência solta o `outros` que o import impôs', () => {
    // Transferência nasce com category `outros` / source `rule` — ninguém
    // escolheu. Virar compra preservando isso tirava a linha da fila da IA
    // para sempre, porque a fila seleciona `category === null`.
    expect(categoriaAposFluxo('transfer', 'expense', 'outros', 'rule')).toBe(null)
    // Mas escolha de verdade sobrevive.
    expect(categoriaAposFluxo('transfer', 'expense', 'outros', 'user')).toBe('outros')
    expect(categoriaAposFluxo('transfer', 'expense', 'lazer', 'user')).toBe('lazer')
  })

  it('#11 categoria com crédito líquido não some da tendência', () => {
    // Comprar em agosto e o estorno chegar em setembro deixa a categoria com
    // líquido POSITIVO. Filtrar por `< 0` a escondia, e o crédito continuava
    // dentro do Total — as colunas somavam mais que a linha Total.
    const liquidos = [{ saude: 3000, alimentacao: -10000 }]
    const comMovimento = ['saude', 'alimentacao'].filter((c) =>
      liquidos.some((mes) => (mes as Record<string, number>)[c] !== 0)
    )
    expect(comMovimento).toContain('saude')
  })
})
