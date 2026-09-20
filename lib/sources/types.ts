/**
 * O contrato que o Open Finance vai reusar. Spec §5.1.
 *
 * O ponto inteiro da inversão de ordem do projeto: quando Pluggy/Belvo
 * entrarem, viram mais uma implementação daqui e nada mais no app muda.
 */

import type { FlowType } from '@/lib/domain/financial-flow'

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
  /**
   * Interpretação financeira do valor bruto. Os adapters deixam ausente;
   * a fronteira de importação preenche depois de conhecer o tipo do extrato.
   */
  flowType?: FlowType
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
  /**
   * O período OBSERVADO: a primeira e a última data que apareceram.
   *
   * Quando o arquivo declara o período no cabeçalho, é ele; quando não
   * declara, é deduzido das transações. Serve para a tela dizer *"de tal a tal
   * dia"* — **não** serve para deduzir o fechamento da fatura. Ver
   * `closingDate`.
   */
  periodStart?: string
  periodEnd?: string
  /**
   * A data de fechamento **declarada pelo arquivo**, e só isso.
   *
   * Existe por um defeito: `periodEnd` era usado como sugestão de dia de
   * fechamento, e `periodEnd` quase nunca é um fechamento. Num CSV ele é a
   * data da **última compra**; num OFX sem `DTEND`, idem. Numa fatura Nubank
   * que fecha dia 13, a última compra pode ser dia 3 — e o app configurava
   * fechamento no dia 3, reparticionando a fatura inteira em torno de uma data
   * inventada, com lançamentos indo parar em meses que a pessoa nunca
   * importou.
   *
   * Só o OFX de **cartão** com `<DTEND>` explícito preenche este campo. O CSV
   * nunca preenche: não existe onde ler isso num CSV, e a pessoa informa na
   * tela de Conta.
   */
  closingDate?: string
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
