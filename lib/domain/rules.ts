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
 * Palavras que aparecem em descrição de banco e não identificam ninguém.
 * Uma regra montada em cima delas casaria com transações sem relação.
 */
const GENERICAS = new Set([
  'PIX', 'TED', 'DOC', 'ENVIADO', 'RECEBIDO', 'TRANSFERENCIA', 'TRANSF',
  'PAGAMENTO', 'PAGTO', 'COMPRA', 'CARTAO', 'DEBITO', 'CREDITO', 'SAQUE',
  'TARIFA', 'TAXA', 'MENSALIDADE', 'FATURA', 'BOLETO', 'CONTA', 'BANCO',
  'LTDA', 'ME', 'EIRELI', 'SA', 'COM', 'BR', 'DA', 'DE', 'DO', 'DAS', 'DOS',
  'E', 'EM', 'NA', 'NO', 'PARA', 'POR',
])

/**
 * Sugere o padrão da regra a partir da descrição anonimizada.
 *
 * A versão anterior devolvia a **descrição inteira**, com a justificativa de
 * ser conservadora. Era conservadora demais: `IFD*IFOOD SAO PAULO` só casaria
 * com outra linha idêntica, e a promessa da §3 D6 — *"próxima vez que IFOOD
 * aparecer, entra certo sem gastar chamada de IA"* — quase nunca se cumpria.
 * A métrica da §9 (≤ 60% das chamadas no 2º mês) dependia disso.
 *
 * A heurística: fica com os dois primeiros termos que **identificam** algo —
 * pelo menos 4 caracteres, não puramente numéricos, e fora da lista de
 * palavras genéricas. `IFD*IFOOD SAO PAULO` vira `IFOOD SAO`; `PIX ENVIADO`
 * não gera sugestão nenhuma, porque não há o que identificar ali.
 *
 * Continua sendo uma **sugestão**: o campo é editável na tela, e vazio
 * significa "não criar regra".
 */
export function sugerirPadrao(descricao: string): string {
  // `*`, `-` e `.` colam código de adquirente no nome do estabelecimento.
  const termos = normalizarPadrao(descricao).split(/[^A-Z0-9]+/)

  const identifica = (termo: string) =>
    termo.length >= 4 && !/^\d+$/.test(termo) && !GENERICAS.has(termo)

  const inicio = termos.findIndex(identifica)
  if (inicio === -1) return ''

  // Só termos ADJACENTES. Juntar termos separados produziria um padrão que
  // nunca casa: `encontrarRegra` usa `includes`, e "IFOOD PAULO" não é
  // substring de "IFD*IFOOD SAO PAULO" — o "SAO" está no meio. Foi assim que
  // a primeira versão desta correção nasceu quebrada, e o teste pegou.
  const escolhidos = [termos[inicio]]
  if (identifica(termos[inicio + 1] ?? '')) escolhidos.push(termos[inicio + 1])

  return escolhidos.join(' ')
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
