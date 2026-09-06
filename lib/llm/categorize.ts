import { anonymize } from '@/lib/privacy/anonymize'
import { encontrarRegra, type RegraCategoria } from '@/lib/domain/rules'
import type { Categoria } from '@/lib/domain/categories'
import { respostaCategoriaSchema } from './schema'
import type { EntradaCategoriaLlm, LLMProvider } from './provider'
import { MAX_CARACTERES_DESCRICAO } from '@/lib/domain/limites'

export const TAMANHO_LOTE = 50
export const MAX_LOTES = 20

export interface TransacaoCategorizavel {
  fingerprint: string
  occurredOn: string
  amountCents: number
  descriptionClean: string
  aiOptOut: boolean
  month: string
  categoryRevision?: number
}

export interface CategoriaAplicada {
  fingerprint: string
  month: string
  category: Categoria
  categorySource: 'ai' | 'rule' | 'user'
  confidence: number | null
  rulePattern?: string
  descriptionClean: string
  expectedRevision: number
}

export interface PlanoCategorizacao {
  /** Resolvidas sem IA: opt-out, entradas e o que casou com uma regra. */
  prontas: CategoriaAplicada[]
  paraIa: Array<{ transacao: TransacaoCategorizavel; clean: string }>
  /** Quantas chamadas à LLM este plano custa. */
  lotes: number
}

/**
 * Decide o que vai à IA **sem chamar nada**.
 *
 * Separado de `categorizarTransacoes` para que a cota possa ser cobrada pelo
 * número real de chamadas. Antes, a rota estimava os lotes contando toda saída
 * sem opt-out — e as regras só eram aplicadas depois, lá dentro: 1.000
 * transações que casassem com regras gastavam 20 unidades da cota e faziam
 * **zero** chamadas.
 */
export function planejarCategorizacao(
  transacoes: readonly TransacaoCategorizavel[],
  regras: readonly RegraCategoria[]
): PlanoCategorizacao {
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
        category: transacao.amountCents >= 0 ? 'receita' : 'outros',
        categorySource: 'user',
        confidence: null,
        descriptionClean: clean,
        expectedRevision: transacao.categoryRevision ?? 0,
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
        expectedRevision: transacao.categoryRevision ?? 0,
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
        expectedRevision: transacao.categoryRevision ?? 0,
      })
      continue
    }

    paraIa.push({ transacao, clean })
  }

  return { prontas, paraIa, lotes: Math.ceil(paraIa.length / TAMANHO_LOTE) }
}

/**
 * Executa o plano: chama a LLM só para o que sobrou.
 */
export async function categorizarTransacoes(
  plano: PlanoCategorizacao,
  provider: LLMProvider,
  revalidar?: (linhas: readonly TransacaoCategorizavel[]) => Promise<ReadonlySet<string>>
): Promise<CategoriaAplicada[]> {
  const { paraIa } = plano
  const prontas: CategoriaAplicada[] = [...plano.prontas]

  for (let inicio = 0; inicio < paraIa.length; inicio += TAMANHO_LOTE) {
    const candidatos = paraIa.slice(inicio, inicio + TAMANHO_LOTE)
    const permitidos = revalidar ? await revalidar(candidatos.map((t) => t.transacao)) : null
    const lote = permitidos
      ? candidatos.filter((t) => permitidos.has(t.transacao.fingerprint))
      : candidatos
    if (lote.length === 0) continue
    const porId = new Map<string, (typeof lote)[number]>()
    const payload: EntradaCategoriaLlm[] = lote.map((item, indice) => {
      const id = `t_${String(indice + 1).padStart(2, '0')}`
      porId.set(id, item)
      return {
        id,
        // Corte de tamanho: a cota conta CHAMADAS, nao tokens, entao um lote
        // de descricoes gigantes custaria o mesmo e gastaria muito mais.
        desc: item.clean.slice(0, MAX_CARACTERES_DESCRICAO),
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
        expectedRevision: item.transacao.categoryRevision ?? 0,
      })
    }
  }

  return prontas
}
