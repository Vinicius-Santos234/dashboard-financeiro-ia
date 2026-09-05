import { describe, expect, it } from 'vitest'
import { obterOuGerarInsight, type InsightCacheado } from '@/lib/llm/insights'
import { rollupVazio } from '@/lib/firestore/rollup'
import type { LLMProvider } from '@/lib/llm/provider'

describe('cache de insights', () => {
  it('abrir duas vezes no mesmo mês faz uma única chamada ao provedor', async () => {
    let cache: InsightCacheado | null = null
    let chamadas = 0
    const provider: LLMProvider = {
      model: 'fake',
      categorizar: async () => [],
      gerarInsight: async () => {
        chamadas += 1
        return {
          headline: 'Alimentação concentrou os gastos',
          items: [{ text: 'O total subiu em relação ao mês anterior.', severity: 'atencao', category: 'alimentacao' }],
        }
      },
    }
    const atual = { ...rollupVazio('2026-08'), count: 1, totalOutCents: -1000 }
    const anterior = rollupVazio('2026-07')
    const deps = {
      provider,
      lerCache: async () => cache,
      salvarCache: async (body: InsightCacheado['body'], model: string) => {
        cache = { body, model }
      },
      lerAgregados: async () => ({ atual, anterior }),
    }

    await obterOuGerarInsight('2026-08', false, deps)
    await obterOuGerarInsight('2026-08', false, deps)

    expect(chamadas).toBe(1)
  })

  it('regerar ignora o cache explicitamente', async () => {
    let chamadas = 0
    const provider: LLMProvider = {
      model: 'fake',
      categorizar: async () => [],
      gerarInsight: async () => {
        chamadas += 1
        return { headline: 'Novo', items: [{ text: 'Novo', severity: 'info', category: null }] }
      },
    }
    const atual = { ...rollupVazio('2026-08'), count: 1 }
    await obterOuGerarInsight('2026-08', true, {
      provider,
      lerCache: async () => ({ headline: 'velho' } as never),
      salvarCache: async () => {},
      lerAgregados: async () => ({ atual, anterior: rollupVazio('2026-07') }),
    })
    expect(chamadas).toBe(1)
  })
})

