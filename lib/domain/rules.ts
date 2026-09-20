import { normalizeDescription } from './fingerprint'
import type { Categoria } from './categories'
import type { FlowType } from './financial-flow'

export interface RegraCategoria {
  pattern: string
  /**
   * A categoria que a regra impõe, ou `null` quando ela **só** diz o fluxo.
   *
   * `null` existe por um defeito concreto: uma correção de fluxo sem categoria
   * conhecida — *"isto é compra, não pagamento de fatura"* — precisaria
   * inventar uma categoria para virar regra, e a única disponível seria
   * `outros`. A partir daí toda transação que casasse com o padrão entraria em
   * `outros` **pela regra**, e nunca mais chegaria à IA: `encontrarRegra`
   * resolve antes do lote, e `category` deixar de ser nulo tira a linha da
   * fila de pendentes para sempre.
   *
   * Com `null`, a regra impõe o fluxo e **deixa a categoria em aberto**.
   */
  category: Categoria | null
  hits: number
  /**
   * O fluxo que esta regra impõe, quando ela nasceu de uma correção de fluxo.
   * Spec 003 §5 D5.
   *
   * Opcional porque a maioria das regras só diz categoria. Quando presente,
   * ela é aplicada **no import**, e não na categorização: o `flowType` decide
   * como a linha entra nos totais, e isso acontece antes de qualquer chamada
   * à IA.
   *
   * Só a pessoa sabe que `PAG*CONDOMINIO` é conta paga e não pagamento de
   * fatura. Reusar o mecanismo de regra é o que faz essa informação valer
   * para os próximos meses sem gastar token.
   */
  flowType?: FlowType
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

/** A regra com categoria, que é a única que a categorização pode aplicar. */
export interface RegraComCategoria extends RegraCategoria {
  category: Categoria
}

/**
 * A regra mais específica que casa com a descrição, dentre as candidatas.
 *
 * O filtro de candidatas fica com quem chama, e essa separação é o ponto:
 * categorização e fluxo perguntam coisas diferentes ao mesmo conjunto, e
 * fazer uma passar pela outra foi o que quebrou — `fluxoDaRegra` construído
 * sobre `encontrarRegra` nunca achava uma regra só de fluxo, porque
 * `encontrarRegra` descarta exatamente essas.
 */
function maisEspecifica<T extends RegraCategoria>(
  descricao: string,
  candidatas: readonly T[]
): T | null {
  const alvo = normalizeDescription(descricao)

  return (
    [...candidatas]
      .filter((regra) => {
        const padrao = normalizarPadrao(regra.pattern)
        return padrao.length >= 3 && alvo.includes(padrao)
      })
      .sort((a, b) => b.pattern.length - a.pattern.length)[0] ?? null
  )
}

/**
 * A regra que decide a CATEGORIA.
 *
 * Regra **só de fluxo** (`category: null`) fica de fora: ela já fez o que
 * tinha para fazer, no import. Deixá-la responder aqui categorizaria a linha
 * sem ninguém ter escolhido categoria nenhuma, e a tiraria da fila da IA de
 * vez.
 */
/**
 * A categoria cabe neste fluxo?
 *
 * `receita` é categoria de **entrada**, e as fatias de gasto a excluem de
 * propósito. Uma regra que ponha uma compra em `receita` tira o valor da pizza
 * sem tirar do total — as fatias somam menos que o card, que é exatamente a
 * divergência que a 001 §4.5 existe para impedir.
 *
 * A mesma checagem já existia na correção manual (`corrigirCategoria`); faltava
 * no caminho da regra, que é o que roda sozinho.
 */
export function categoriaCabeNoFluxo(
  category: Categoria,
  flowType: FlowType | undefined
): boolean {
  if (flowType === 'income') return category === 'receita'
  if (flowType === 'expense' || flowType === 'refund') return category !== 'receita'
  // Transferência não recebe categoria de gasto, e fluxo desconhecido não é
  // motivo para afrouxar: `receita` só entra onde ela faz sentido.
  return category !== 'receita'
}

export function encontrarRegra(
  descricao: string,
  regras: readonly RegraCategoria[],
  /** O fluxo da transação que vai receber a categoria, quando conhecido. */
  flowType?: FlowType
): RegraComCategoria | null {
  return maisEspecifica(
    descricao,
    regras.filter(
      (regra): regra is RegraComCategoria =>
        regra.category !== null && categoriaCabeNoFluxo(regra.category, flowType)
    )
  )
}

/**
 * O fluxo que as regras impõem a esta descrição, se alguma impuser.
 * Spec 003 §8 C5.
 *
 * Roda no import, sobre a descrição **crua** — a regra de fluxo precisa casar
 * com o que o banco escreveu, que é onde `PAGTO FATURA` e `PAG*LOJA` se
 * confundem. É exatamente essa confusão que a correção manual existe para
 * desfazer.
 *
 * Só regras com `flowType` participam: uma regra de categoria não tem opinião
 * sobre fluxo, e deixá-la responder aqui transformaria toda correção de
 * categoria numa mudança silenciosa de total.
 */
export function fluxoDaRegra(
  descricao: string,
  regras: readonly RegraCategoria[]
): FlowType | null {
  // Candidatas são as que TÊM fluxo, com ou sem categoria — ao contrário de
  // `encontrarRegra`, que exige categoria. Uma regra só de fluxo é justamente
  // a que precisa ser encontrada aqui.
  const comFluxo = regras.filter((regra) => regra.flowType !== undefined)
  return maisEspecifica(descricao, comFluxo)?.flowType ?? null
}
