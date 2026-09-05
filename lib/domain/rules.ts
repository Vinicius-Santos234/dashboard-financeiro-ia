import { normalizeDescription } from './fingerprint'
import type { Categoria } from './categories'

export interface RegraCategoria {
  pattern: string
  category: Categoria
  hits: number
}

export function normalizarPadrao(valor: string): string {
  return normalizeDescription(valor).slice(0, 120).trim()
}

/**
 * Um padrão sugerido deve ser conservador. Uma regra ampla como "PIX" faria
 * pagamentos diferentes herdarem a mesma categoria; a descrição anonimizada
 * completa é uma escolha mais segura e continua editável pela pessoa.
 */
export function sugerirPadrao(descricao: string): string {
  return normalizarPadrao(descricao)
}

export function encontrarRegra(
  descricao: string,
  regras: readonly RegraCategoria[]
): RegraCategoria | null {
  const alvo = normalizeDescription(descricao)

  // A regra mais específica ganha quando duas casam.
  return (
    [...regras]
      .filter((regra) => {
        const padrao = normalizarPadrao(regra.pattern)
        return padrao.length >= 3 && alvo.includes(padrao)
      })
      .sort((a, b) => b.pattern.length - a.pattern.length)[0] ?? null
  )
}
