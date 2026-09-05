import type { Rollup } from '@/lib/firestore/rollup'
import type { InsightBody } from './schema'
import type { LLMProvider } from './provider'

export interface InsightCacheado {
  body: InsightBody
  model: string
}

export interface DependenciasInsight {
  provider: LLMProvider
  lerCache: () => Promise<InsightCacheado | null>
  salvarCache: (body: InsightBody, model: string) => Promise<void>
  lerAgregados: () => Promise<{ atual: Rollup; anterior: Rollup }>
}

/** Cache-aside explícito: abrir novamente lê o Firestore e não chama a LLM. */
export async function obterOuGerarInsight(
  month: string,
  regerar: boolean,
  deps: DependenciasInsight
): Promise<{ insight: InsightCacheado; gerado: boolean }> {
  if (!regerar) {
    const existente = await deps.lerCache()
    if (existente) return { insight: existente, gerado: false }
  }

  const { atual, anterior } = await deps.lerAgregados()
  if (atual.count === 0) throw new Error('Não há transações neste mês para gerar insights.')

  const body = await deps.provider.gerarInsight({
    month,
    current: atual.byCategory,
    previous: anterior.byCategory,
    totalOutCents: atual.totalOutCents,
    previousTotalOutCents: anterior.totalOutCents,
  })
  await deps.salvarCache(body, deps.provider.model)
  return { insight: { body, model: deps.provider.model }, gerado: true }
}

