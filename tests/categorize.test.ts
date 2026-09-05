import { describe, expect, it } from 'vitest'
import { categorizarTransacoes, MAX_LOTES, TAMANHO_LOTE } from '@/lib/llm/categorize'
import type { LLMProvider } from '@/lib/llm/provider'
import type { InsightBody } from '@/lib/llm/schema'

function transacao(indice: number, descricao = 'PADARIA SAO JOAO') {
  return {
    fingerprint: `h_segredo_${indice}`,
    occurredOn: '2026-08-14',
    month: '2026-08',
    amountCents: -1000 - indice,
    descriptionClean: descricao,
    aiOptOut: false,
  }
}

class ProviderFake implements LLMProvider {
  readonly model = 'fake'
  chamadas: Array<readonly { id: string; desc: string; v: number; d: string }[]> = []

  async categorizar(entrada: readonly { id: string; desc: string; v: number; d: string }[]) {
    this.chamadas.push(entrada)
    return entrada.map((item) => ({
      id: item.id,
      category: 'alimentacao',
      confidence: 0.92,
    }))
  }

  async gerarInsight(): Promise<InsightBody> {
    return { headline: 'fake', items: [{ text: 'fake', severity: 'info', category: null }] }
  }
}

describe('categorizarTransacoes', () => {
  it('envia lotes de no máximo 50 com ids opacos e descrição anonimizada', async () => {
    const provider = new ProviderFake()
    const entrada = Array.from({ length: 51 }, (_, i) =>
      transacao(i, `IFOOD CPF 123.456.789-09 PEDIDO ${123456 + i}`)
    )

    const resultado = await categorizarTransacoes(entrada, [], provider)

    expect(provider.chamadas.map((c) => c.length)).toEqual([50, 1])
    expect(provider.chamadas[0][0]).toEqual({
      id: 't_01',
      desc: 'IFOOD CPF PEDIDO',
      v: -1000,
      d: '2026-08-14',
    })
    expect(JSON.stringify(provider.chamadas)).not.toContain('h_segredo')
    expect(resultado).toHaveLength(51)
  })

  it('aplica regra e opt-out sem chamar a IA', async () => {
    const provider = new ProviderFake()
    const resultado = await categorizarTransacoes(
      [
        transacao(1, 'UBER TRIP'),
        { ...transacao(2, 'CLINICA SENSIVEL'), aiOptOut: true },
      ],
      [{ pattern: 'UBER', category: 'transporte', hits: 2 }],
      provider
    )

    expect(provider.chamadas).toHaveLength(0)
    expect(resultado[0]).toMatchObject({ category: 'transporte', categorySource: 'rule' })
    expect(resultado[1]).toMatchObject({ category: 'outros', categorySource: 'user' })
  })

  it('classifica entradas como receita sem consumir tokens', async () => {
    const provider = new ProviderFake()
    const [resultado] = await categorizarTransacoes(
      [{ ...transacao(1, 'SALARIO EMPRESA'), amountCents: 320000 }],
      [],
      provider
    )
    expect(provider.chamadas).toHaveLength(0)
    expect(resultado).toMatchObject({ category: 'receita', categorySource: 'rule' })
  })

  it('descarta ids desconhecidos e transforma resposta ausente em outros', async () => {
    const provider = new ProviderFake()
    provider.categorizar = async () => [
      { id: 'intruso', category: 'moradia', confidence: 1 },
      { id: 't_01', category: 'categoria-inventada', confidence: 8 },
    ]

    const [resultado] = await categorizarTransacoes([transacao(1)], [], provider)
    expect(resultado).toMatchObject({ category: 'outros', confidence: 0, categorySource: 'ai' })
  })

  it('recusa mais de vinte lotes', async () => {
    const provider = new ProviderFake()
    const entrada = Array.from({ length: TAMANHO_LOTE * MAX_LOTES + 1 }, (_, i) =>
      transacao(i)
    )
    await expect(categorizarTransacoes(entrada, [], provider)).rejects.toThrow(/limite/)
  })
})
