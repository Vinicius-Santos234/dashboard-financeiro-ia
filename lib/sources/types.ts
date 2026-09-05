/**
 * O contrato que o Open Finance vai reusar. Spec §5.1.
 *
 * O ponto inteiro da inversão de ordem do projeto: quando Pluggy/Belvo
 * entrarem, viram mais uma implementação daqui e nada mais no app muda.
 */

export type SourceId = 'ofx' | 'csv' | 'bot' | 'openfinance'

export interface RawTransaction {
  /** ISO `YYYY-MM-DD`, no fuso em que o banco escreveu. */
  occurredOn: string
  /** Centavos. Negativo = saída, positivo = entrada. */
  amountCents: number
  /** Como veio da fonte, sem tratamento nenhum. */
  description: string
  /** Id da transação no banco, quando a fonte fornece. */
  fitid?: string
}

export interface ContaDetectada {
  /** Número da conta como a fonte informou. Só para exibir ao usuário. */
  id?: string
  institution?: string
  kind?: 'checking' | 'savings' | 'credit_card'
  /** Código ISO. Serve para recusar extrato que não seja em BRL (§2). */
  currency?: string
}

export interface LinhaDescartada {
  /** 1-indexado, para a mensagem fazer sentido para quem abre o arquivo. */
  linha: number
  conteudo: string
  motivo: string
}

export interface ParseResult {
  transactions: RawTransaction[]
  account?: ContaDetectada
  periodStart?: string
  periodEnd?: string
  /**
   * Linhas que a fonte trouxe e o parser não conseguiu ler.
   *
   * Existe pelo mesmo motivo que `parseAmountToCents` levanta erro em vez de
   * chutar: descartar linha em silêncio faz o total do dashboard divergir do
   * extrato sem nenhuma pista de onde. Quem importa precisa ver quantas
   * ficaram de fora e por quê.
   */
  descartadas: LinhaDescartada[]
}

export interface SourceAdapter<Opcoes = void> {
  readonly id: SourceId
  parse(input: ArrayBuffer | string, opcoes: Opcoes): Promise<ParseResult>
}
