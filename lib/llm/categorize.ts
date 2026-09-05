import { anonymize } from '@/lib/privacy/anonymize'
import { encontrarRegra, type RegraCategoria } from '@/lib/domain/rules'
import type { Categoria } from '@/lib/domain/categories'
import { respostaCategoriaSchema } from './schema'
import type { EntradaCategoriaLlm, LLMProvider } from './provider'

export const TAMANHO_LOTE = 50
export const MAX_LOTES = 20

export interface TransacaoCategorizavel {
  fingerprint: string
  occurredOn: string
  amountCents: number
  descriptionClean: string
  aiOptOut: boolean
  month: string
}

export interface CategoriaAplicada {
  fingerprint: string
  month: string
  category: Categoria
  categorySource: 'ai' | 'rule' | 'user'
  confidence: number | null
  rulePattern?: string
  descriptionClean: string
}

export async function categorizarTransacoes(
  transacoes: readonly TransacaoCategorizavel[],
  regras: readonly RegraCategoria[],
  provider: LLMProvider
): Promise<CategoriaAplicada[]> {
  if (transacoes.length > TAMANHO_LOTE * MAX_LOTES) {
    throw new Error(`O limite de categorização é ${TAMANHO_LOTE * MAX_LOTES} transações.`)
  }

  const prontas: CategoriaAplicada[] = []
  const paraIa: Array<{
    transacao: TransacaoCategorizavel
    clean: string
  }> = []

  for (const transacao of transacoes) {
    // Defesa de fronteira: não confia que uma versão anterior gravou clean.
    const clean = anonymize(transacao.descriptionClean)

    if (transacao.aiOptOut) {
      prontas.push({
        fingerprint: transacao.fingerprint,
        month: transacao.month,
        category: 'outros',
        categorySource: 'user',
        confidence: null,
        descriptionClean: clean,
      })
      continue
    }

    // A separação exata entre entradas e fatias de gasto depende de entradas
    // viverem em `receita`. Além de ser determinístico, isso economiza tokens.
    if (transacao.amountCents >= 0) {
      prontas.push({
        fingerprint: transacao.fingerprint,
        month: transacao.month,
        category: 'receita',
        categorySource: 'rule',
        confidence: 1,
        descriptionClean: clean,
      })
      continue
    }

    const regra = encontrarRegra(clean, regras)
    if (regra) {
      prontas.push({
        fingerprint: transacao.fingerprint,
        month: transacao.month,
        category: regra.category,
        categorySource: 'rule',
        confidence: 1,
        rulePattern: regra.pattern,
        descriptionClean: clean,
      })
      continue
    }

    paraIa.push({ transacao, clean })
  }

  for (let inicio = 0; inicio < paraIa.length; inicio += TAMANHO_LOTE) {
    const lote = paraIa.slice(inicio, inicio + TAMANHO_LOTE)
    const porId = new Map<string, (typeof lote)[number]>()
    const payload: EntradaCategoriaLlm[] = lote.map((item, indice) => {
      const id = `t_${String(indice + 1).padStart(2, '0')}`
      porId.set(id, item)
      return {
        id,
        desc: item.clean,
        v: item.transacao.amountCents,
        d: item.transacao.occurredOn,
      }
    })

    const bruto = await provider.categorizar(payload)
    const respostas = Array.isArray(bruto) ? bruto : []
    const validas = new Map<string, ReturnType<typeof respostaCategoriaSchema.parse>>()

    for (const item of respostas) {
      const parsed = respostaCategoriaSchema.safeParse(item)
      if (!parsed.success || !porId.has(parsed.data.id)) continue
      validas.set(parsed.data.id, parsed.data)
    }

    for (const [id, item] of porId) {
      const resposta = validas.get(id)
      prontas.push({
        fingerprint: item.transacao.fingerprint,
        month: item.transacao.month,
        category: resposta?.category ?? 'outros',
        categorySource: 'ai',
        confidence: resposta?.confidence ?? 0,
        descriptionClean: item.clean,
      })
    }
  }

  return prontas
}
