import type { InsightBody } from './schema'

export interface EntradaCategoriaLlm {
  id: string
  desc: string
  v: number
  d: string
}

export interface EntradaInsightLlm {
  month: string
  current: Record<string, number>
  previous: Record<string, number>
  totalOutCents: number
  previousTotalOutCents: number
}

export interface LLMProvider {
  readonly model: string
  categorizar(entrada: readonly EntradaCategoriaLlm[]): Promise<unknown>
  gerarInsight(entrada: EntradaInsightLlm): Promise<InsightBody>
}

