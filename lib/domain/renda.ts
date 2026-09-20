/**
 * A renda mensal digitada, e o percentual que ela serve de denominador.
 * Spec 003 §5 D4 e §7.
 *
 * A renda **mora no perfil, não no rollup**: ela não é um fato do mês
 * importado, é uma declaração da pessoa, que vale até ela mudar. Guardá-la por
 * mês criaria a obrigação de preenchê-la doze vezes para ver uma tendência.
 */

/**
 * `null` não é zero, e a diferença aparece na tela.
 *
 * Sem renda informada o app **não mostra percentual nenhum** — nem `0%`, nem
 * `100%`. Um denominador ausente e um denominador zerado levam a leituras
 * opostas, e inventar o segundo seria mentir.
 *
 * Renda zero ou negativa cai no mesmo caminho da ausente por segurança: o
 * formulário já recusa, e aqui a divisão por zero não tem como escapar para a
 * tela como `Infinity%`.
 */
export function percentualDaRenda(
  gastoLiquidoCents: number,
  rendaMensalCents: number | null
): number | null {
  if (rendaMensalCents === null || rendaMensalCents <= 0) return null
  return (gastoLiquidoCents / rendaMensalCents) * 100
}

/**
 * A renda é **líquida** — o que cai na conta, já descontados imposto e INSS.
 *
 * A spec deixou isto em aberto (§11) e a escolha é esta, pelo motivo prático:
 * a pessoa compara a fatura com o dinheiro que ela de fato tem para pagá-la,
 * não com o salário do contracheque. O campo diz isso em texto, porque a
 * pessoa não deve ter que adivinhar qual das duas o percentual usa.
 */
export const RENDA_E_LIQUIDA = true

/**
 * Há quanto tempo a renda foi declarada, em dias.
 *
 * Existe porque a renda digitada envelhece em silêncio (003 §10): um
 * percentual calculado sobre um salário de dois anos atrás é um número errado
 * que parece certo. A tela diz desde quando o valor vale.
 */
export function diasDesde(iso: string, agora: Date = new Date()): number {
  const quando = new Date(iso).getTime()
  if (Number.isNaN(quando)) return 0
  return Math.max(0, Math.floor((agora.getTime() - quando) / 86_400_000))
}

/** A partir de quando a tela avisa que a renda pode estar velha. */
export const DIAS_PARA_RENDA_ENVELHECER = 180
