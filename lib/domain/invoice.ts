/**
 * A fatura como unidade de período. Spec 003 §5 D2 e §8 C8.
 *
 * A unidade que a pessoa reconhece é a **fatura**, não o mês civil: compras de
 * uma mesma fatura atravessam dois meses civis, e somá-las pelo calendário
 * produz dois meios-totais que não correspondem a nenhuma cobrança real.
 *
 * O período continua sendo uma chave `YYYY-MM`, e continua sendo o campo
 * `month` do documento — o que muda é o que ela significa para uma conta de
 * cartão: **o mês em que a fatura FECHA**, e não o mês em que a compra
 * aconteceu.
 */

/** Dia do fechamento, 1 a 28. */
export type DiaDeFechamento = number

/**
 * 28 é o teto de propósito: 29, 30 e 31 não existem em todo mês, e um
 * fechamento no dia 31 pularia fevereiro inteiro.
 */
export const MAIOR_DIA_DE_FECHAMENTO = 28

export function diaDeFechamentoValido(valor: unknown): valor is DiaDeFechamento {
  return (
    typeof valor === 'number' &&
    Number.isInteger(valor) &&
    valor >= 1 &&
    valor <= MAIOR_DIA_DE_FECHAMENTO
  )
}

/**
 * A qual fatura pertence uma compra.
 *
 * Uma compra feita **depois** do fechamento entra na fatura seguinte — é a
 * regra que todo cartão usa, e é o critério de aceite da C8: uma compra de
 * 28/09 numa fatura que fecha em 03/10 aparece na fatura de **outubro**.
 *
 *     fecha dia 3:  04/09 … 03/10  →  fatura de outubro
 *
 * Sem dia de fechamento (`null`), o período é o mês civil. Isso mantém o
 * comportamento anterior para toda conta que ainda não configurou a fatura, e
 * é o que faz esta etapa não quebrar dado que ninguém pediu para migrar.
 */
export function periodoDaFatura(
  occurredOn: string,
  closingDay: DiaDeFechamento | null
): string {
  const mesCivil = occurredOn.slice(0, 7)
  if (closingDay === null) return mesCivil

  const dia = Number(occurredOn.slice(8, 10))
  if (!Number.isInteger(dia)) return mesCivil

  // No dia do fechamento ou antes, a compra ainda entra na fatura que fecha
  // neste mês. Depois dele, já é a próxima.
  if (dia <= closingDay) return mesCivil

  const [ano, numero] = mesCivil.split('-').map(Number)
  return numero === 12
    ? `${ano + 1}-01`
    : `${ano}-${String(numero + 1).padStart(2, '0')}`
}

/**
 * O intervalo de datas que uma fatura cobre, para a tela poder dizê-lo.
 *
 * `2026-10` com fechamento no dia 3 cobre de `2026-09-04` a `2026-10-03`.
 */
export function intervaloDaFatura(
  periodo: string,
  closingDay: DiaDeFechamento
): { de: string; ate: string } {
  const [ano, numero] = periodo.split('-').map(Number)

  const fim = new Date(Date.UTC(ano, numero - 1, closingDay))
  const inicio = new Date(Date.UTC(ano, numero - 2, closingDay + 1))

  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { de: iso(inicio), ate: iso(fim) }
}

/**
 * O dia de fechamento sugerido pelo arquivo importado.
 *
 * O OFX de cartão declara `DTEND`, que num extrato de fatura é a data de
 * fechamento. É uma **sugestão**, não um fato: alguns exportadores põem ali a
 * data em que o arquivo foi gerado. Por isso ela só preenche uma conta que
 * ainda não tem fechamento configurado, e a tela diz de onde o valor veio.
 */
export function fechamentoSugerido(periodEnd: string | null | undefined): DiaDeFechamento | null {
  if (!periodEnd) return null
  const dia = Number(periodEnd.slice(8, 10))
  return diaDeFechamentoValido(dia) ? dia : null
}
