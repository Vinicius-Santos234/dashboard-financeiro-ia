/**
 * O tipo da conta, e a leitura que ele obriga. Spec 003 §5 D3.
 *
 * Este arquivo existe para o tipo da conta poder ser lido fora do servidor.
 * Ele morava em `lib/firestore/repo.ts`, que é `server-only`, e por isso a
 * tela não tinha como perguntar "esta origem tem saldo?" sem importar o
 * Firestore inteiro.
 */

export const TIPOS_CONTA = ['checking', 'savings', 'credit_card'] as const
export type TipoConta = (typeof TIPOS_CONTA)[number]

/**
 * O que a tela mostra depende da ORIGEM, não da fonte. Spec 003 §4.
 *
 * `fatura` e `conta` não são dois temas do mesmo painel: são dois conjuntos de
 * números diferentes. Cartão não tem saldo nem recebido — e o app que se
 * anuncia como controlador de fatura mostrando "saldo: −R$ 1.622" é, nas
 * palavras da spec, *pior que os dois produtos separados*.
 */
export type Origem = 'fatura' | 'conta'

export type ContagemPorTipo = Record<TipoConta, number>

export function contagemPorTipoVazia(): ContagemPorTipo {
  return { checking: 0, savings: 0, credit_card: 0 }
}

/**
 * A origem de um mês, a partir de quantas transações vieram de cada tipo.
 *
 * **Basta uma transação de conta corrente para o mês ser `conta`.** A regra é
 * assimétrica de propósito: num mês misto existe saldo de verdade, e esconder
 * o saldo de quem tem conta seria o mesmo erro da versão anterior, ao
 * contrário. Já o inverso não vale — mostrar saldo porque há uma fatura junto
 * inventaria um número que o cartão não tem.
 *
 * Mês sem nenhuma transação devolve `null`: quem chama decide o que fazer com
 * a ausência, e ela não é a mesma coisa que "é fatura".
 */
export function origemDaContagem(contagem: ContagemPorTipo): Origem | null {
  const deConta = contagem.checking + contagem.savings
  const deCartao = contagem.credit_card

  if (deConta > 0) return 'conta'
  if (deCartao > 0) return 'fatura'
  return null
}

/**
 * A origem quando o mês está vazio — ou quando o rollup é anterior a esta
 * versão e não guarda a contagem por tipo.
 *
 * Sem conta nenhuma cadastrada, o padrão é **fatura**: é a proposta do produto
 * (D1), e é o que a tela vazia precisa dizer para não prometer um extrato
 * bancário que deixou de ser o caso principal.
 */
export function origemDasContas(
  contas: readonly { kind?: TipoConta }[]
): Origem {
  if (contas.length === 0) return 'fatura'
  return contas.some((c) => c.kind === 'checking' || c.kind === 'savings')
    ? 'conta'
    : 'fatura'
}

export const ORIGEM_LABEL: Record<Origem, string> = {
  fatura: 'Fatura de cartão',
  conta: 'Conta corrente',
}
