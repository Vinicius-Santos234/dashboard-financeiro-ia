import { CATEGORIAS, type Categoria } from '@/lib/domain/categories'
import {
  contagemPorTipoVazia,
  origemDaContagem,
  TIPOS_CONTA,
  type ContagemPorTipo,
  type Origem,
  type TipoConta,
} from '@/lib/domain/account'
import {
  categoryAmountCents,
  resolvedFlowType,
  type FlowType,
} from '@/lib/domain/financial-flow'

/**
 * O agregado mensal que substitui o `group by`. Spec §4.5.
 *
 * O Firestore não tem `group by`. A alternativa ingênua seria uma query por
 * categoria (dez queries por mês) ou varrer o mês inteiro no cliente. O rollup
 * troca isso por **uma leitura de documento** — mas cria a obrigação de
 * mantê-lo em dia, e é aí que esse padrão costuma apodrecer.
 *
 * Por isso as funções de cálculo vivem aqui, puras e sem Firestore: dá para
 * testar que o rollup bate com o recálculo sem subir banco nenhum.
 */

export type PorCategoria = Record<Categoria, number>

export interface Rollup {
  month: string
  totalInCents: number
  /** Compras/despesas brutas, sempre zero ou negativo. */
  totalOutCents: number
  /** Créditos e estornos que reduzem despesas, sempre positivo. */
  totalRefundCents: number
  /** Pagamentos de fatura e transferências, fora do resultado do mês. */
  totalTransferCents: number
  count: number
  /**
   * Gasto e receita BRUTOS por categoria. Despesa negativa, receita positiva,
   * estorno **não entra aqui** — ele vive em `refundByCategory`.
   *
   * A versão anterior somava o estorno aqui, líquido, e isso quebrava a soma:
   * um estorno que caísse numa categoria sem despesa no mês deixava a fatia
   * positiva, e a pizza (que só desenha fatia negativa) descartava a categoria
   * inteira — enquanto o total do mês subtraía aquele estorno assim mesmo. As
   * fatias somavam 100 embaixo de um card escrito 70.
   */
  byCategory: PorCategoria
  /**
   * Estorno por categoria, sempre positivo. Ausente em rollup gravado antes
   * desta versão; `lerRollup` normaliza.
   *
   * Separar é o que permite as três leituras baterem ao centavo:
   * `bruto − estornos = líquido`, com a pizza somando exatamente o bruto.
   */
  refundByCategory: PorCategoria
  /**
   * Quantas transações do mês vieram de cada tipo de conta. Spec 003 §8 C2.
   *
   * É o que permite a tela obedecer à origem sem ler o mês inteiro: o rollup
   * custa **uma** leitura de documento, e perguntar "esta fatura tem saldo?"
   * varrendo as transações desfaria exatamente a economia que ele existe para
   * dar.
   *
   * Ausente em rollup gravado antes desta versão; `lerRollup` normaliza, e a
   * origem cai para a lista de contas quando a contagem está toda zerada.
   */
  byAccountKind: ContagemPorTipo
}

/** Todas as dez chaves em zero. Categoria ausente e categoria zerada precisam
 * ser a mesma coisa, senão o gráfico ganha buraco quando um mês não tem lazer. */
export function porCategoriaVazio(): PorCategoria {
  return Object.fromEntries(CATEGORIAS.map((c) => [c, 0])) as PorCategoria
}

export function rollupVazio(month: string): Rollup {
  return {
    month,
    totalInCents: 0,
    totalOutCents: 0,
    totalRefundCents: 0,
    totalTransferCents: 0,
    count: 0,
    byCategory: porCategoriaVazio(),
    refundByCategory: porCategoriaVazio(),
    byAccountKind: contagemPorTipoVazia(),
  }
}

export interface LinhaAgregavel {
  month: string
  amountCents: number
  category: Categoria | null
  flowType?: FlowType
  /** Ausente em linha de rollup legado; conta como origem desconhecida. */
  accountKind?: TipoConta
}

function somarLinha(
  destino: Omit<Rollup, 'month'>,
  linha: LinhaAgregavel
): void {
  const amount = Math.abs(linha.amountCents)
  const flowType = resolvedFlowType(linha)

  destino.count += 1
  if (linha.accountKind) destino.byAccountKind[linha.accountKind] += 1
  if (flowType === 'income') destino.totalInCents += amount
  if (flowType === 'expense') destino.totalOutCents -= amount
  if (flowType === 'refund') destino.totalRefundCents += amount
  if (flowType === 'transfer') destino.totalTransferCents += amount

  // Transferência tem contribuição zero nas duas divisões: pagamento de fatura
  // não é gasto de categoria nenhuma nem crédito de categoria nenhuma.
  const categoria = linha.category ?? 'outros'
  if (flowType === 'refund') destino.refundByCategory[categoria] += amount
  else {
    destino.byCategory[categoria] += categoryAmountCents({
      amountCents: linha.amountCents,
      description: '',
      flowType,
    })
  }
}

/**
 * Recalcula do zero a partir das transações do mês.
 *
 * Esta é a fonte da verdade. O rollup guardado é um cache dela, e o teste da
 * §4.5 afirma que os dois batem.
 */
export function calcularRollup(
  month: string,
  linhas: readonly LinhaAgregavel[]
): Rollup {
  const r = rollupVazio(month)

  for (const linha of linhas) {
    if (linha.month !== month) continue

    somarLinha(r, linha)
  }

  return r
}

/**
 * O que somar ao rollup quando transações entram.
 *
 * Devolver um delta em vez de reescrever o rollup inteiro é o que permite
 * aplicar isso dentro de uma transação do Firestore sem ler o mês todo.
 */
export function deltaDeInsercao(linhas: readonly LinhaAgregavel[]): Omit<Rollup, 'month'> {
  const d = {
    totalInCents: 0,
    totalOutCents: 0,
    totalRefundCents: 0,
    totalTransferCents: 0,
    count: 0,
    byCategory: porCategoriaVazio(),
    refundByCategory: porCategoriaVazio(),
    byAccountKind: contagemPorTipoVazia(),
  }

  for (const linha of linhas) {
    somarLinha(d, linha)
  }

  return d
}

/** O delta com todos os sinais trocados. */
function negar(d: Omit<Rollup, 'month'>): Omit<Rollup, 'month'> {
  const byCategory = porCategoriaVazio()
  const refundByCategory = porCategoriaVazio()
  for (const c of CATEGORIAS) {
    byCategory[c] = -(d.byCategory[c] ?? 0)
    refundByCategory[c] = -(d.refundByCategory[c] ?? 0)
  }
  const byAccountKind = contagemPorTipoVazia()
  for (const k of TIPOS_CONTA) byAccountKind[k] = -(d.byAccountKind[k] ?? 0)

  return {
    totalInCents: -d.totalInCents,
    totalOutCents: -d.totalOutCents,
    totalRefundCents: -d.totalRefundCents,
    totalTransferCents: -d.totalTransferCents,
    count: -d.count,
    byCategory,
    refundByCategory,
    byAccountKind,
  }
}

function somarDeltas(
  a: Omit<Rollup, 'month'>,
  b: Omit<Rollup, 'month'>
): Omit<Rollup, 'month'> {
  // `aplicarDelta` já sabe somar campo a campo; o `month` sintético só existe
  // para satisfazer o tipo e é descartado.
  const soma = aplicarDelta({ month: '', ...a }, b)
  return soma
}

/**
 * O delta de trocar o fluxo de uma linha. Spec 003 §8 C5.
 *
 * Mover uma transação entre `expense`, `refund` e `transfer` mexe em **três
 * totais diferentes** e ainda troca de mapa por categoria — o estorno vive em
 * `refundByCategory`, a despesa em `byCategory`, e a transferência em nenhum
 * dos dois. Escrever esse delta à mão seria seis oportunidades de errar um
 * sinal.
 *
 * Em vez disso, a linha é agregada duas vezes, como se estivesse entrando: uma
 * do jeito antigo, outra do novo. A diferença entre as duas é, por
 * construção, exatamente o que precisa mudar no agregado — e `count` se anula
 * sozinho, porque a transação não deixou de existir.
 */
export function deltaDeMudancaDeFluxo(
  antes: LinhaAgregavel,
  depois: LinhaAgregavel
): Omit<Rollup, 'month'> {
  return somarDeltas(deltaDeInsercao([depois]), negar(deltaDeInsercao([antes])))
}

/**
 * O delta de uma recategorização: tira o valor de onde estava e põe onde
 * passou a estar. Os totais não mudam — só a divisão entre categorias.
 */
export interface DeltaDeCategoria {
  byCategory: Partial<PorCategoria>
  refundByCategory: Partial<PorCategoria>
}

export function deltaDeRecategorizacao(
  amountCents: number,
  de: Categoria | null,
  para: Categoria,
  flowType?: FlowType
): DeltaDeCategoria {
  const vazio: DeltaDeCategoria = { byCategory: {}, refundByCategory: {} }
  const anterior = de ?? 'outros'
  if (anterior === para) return vazio

  // O estorno se move dentro do MAPA DELE. Movê-lo em `byCategory` somaria um
  // crédito onde só existe gasto bruto, e a diferença voltaria a aparecer como
  // deriva entre a pizza e o total.
  if (resolvedFlowType({ amountCents, flowType }) === 'refund') {
    const amount = Math.abs(amountCents)
    return {
      byCategory: {},
      refundByCategory: { [anterior]: -amount, [para]: amount } as Partial<PorCategoria>,
    }
  }

  const valor = categoryAmountCents({ amountCents, description: '', flowType })
  if (valor === 0) return vazio
  return {
    byCategory: { [anterior]: -valor, [para]: valor } as Partial<PorCategoria>,
    refundByCategory: {},
  }
}

/**
 * Embrulha um movimento entre categorias como delta de rollup completo.
 *
 * Recategorizar não muda total nenhum — só a divisão. Os cinco zeros estavam
 * escritos à mão em três lugares de `repo.ts`, e cada campo novo do rollup
 * obrigava a lembrar dos três. Agora esquecer um deles não compila.
 */
export function deltaSoDeCategoria(d: DeltaDeCategoria): Omit<Rollup, 'month'> {
  return {
    totalInCents: 0,
    totalOutCents: 0,
    totalRefundCents: 0,
    totalTransferCents: 0,
    count: 0,
    byCategory: { ...porCategoriaVazio(), ...d.byCategory },
    refundByCategory: { ...porCategoriaVazio(), ...d.refundByCategory },
    // Recategorizar não move transação entre contas: a origem do mês é a
    // mesma antes e depois.
    byAccountKind: contagemPorTipoVazia(),
  }
}

export function aplicarDelta(base: Rollup, delta: Omit<Rollup, 'month'>): Rollup {
  const byCategory = porCategoriaVazio()
  const refundByCategory = porCategoriaVazio()
  for (const c of CATEGORIAS) {
    byCategory[c] = (base.byCategory[c] ?? 0) + (delta.byCategory[c] ?? 0)
    refundByCategory[c] =
      (base.refundByCategory?.[c] ?? 0) + (delta.refundByCategory?.[c] ?? 0)
  }

  const byAccountKind = contagemPorTipoVazia()
  for (const k of TIPOS_CONTA) {
    byAccountKind[k] =
      (base.byAccountKind?.[k] ?? 0) + (delta.byAccountKind?.[k] ?? 0)
  }

  return {
    month: base.month,
    totalInCents: base.totalInCents + delta.totalInCents,
    totalOutCents: base.totalOutCents + delta.totalOutCents,
    totalRefundCents:
      (base.totalRefundCents ?? 0) + delta.totalRefundCents,
    totalTransferCents:
      (base.totalTransferCents ?? 0) + delta.totalTransferCents,
    count: base.count + delta.count,
    byCategory,
    refundByCategory,
    byAccountKind,
  }
}

/**
 * Confere se o rollup guardado bate com o recálculo.
 *
 * Usada no teste e disponível para uma tela de diagnóstico. Devolve a lista de
 * divergências em vez de um booleano porque "está errado" não ajuda ninguém a
 * consertar — "alimentacao: guardado -12345, real -12000" ajuda.
 */
export function divergencias(guardado: Rollup, real: Rollup): string[] {
  const problemas: string[] = []

  if (guardado.count !== real.count) {
    problemas.push(`count: guardado ${guardado.count}, real ${real.count}`)
  }
  if (guardado.totalInCents !== real.totalInCents) {
    problemas.push(`totalInCents: guardado ${guardado.totalInCents}, real ${real.totalInCents}`)
  }
  if (guardado.totalOutCents !== real.totalOutCents) {
    problemas.push(`totalOutCents: guardado ${guardado.totalOutCents}, real ${real.totalOutCents}`)
  }
  if ((guardado.totalRefundCents ?? 0) !== real.totalRefundCents) {
    problemas.push(
      `totalRefundCents: guardado ${guardado.totalRefundCents ?? 0}, real ${real.totalRefundCents}`
    )
  }
  if ((guardado.totalTransferCents ?? 0) !== real.totalTransferCents) {
    problemas.push(
      `totalTransferCents: guardado ${guardado.totalTransferCents ?? 0}, real ${real.totalTransferCents}`
    )
  }
  for (const c of CATEGORIAS) {
    const ge = guardado.refundByCategory?.[c] ?? 0
    const ve = real.refundByCategory?.[c] ?? 0
    if (ge !== ve) {
      problemas.push(`refundByCategory.${c}: guardado ${ge}, real ${ve}`)
    }
  }
  for (const c of CATEGORIAS) {
    const g = guardado.byCategory[c] ?? 0
    const v = real.byCategory[c] ?? 0
    if (g !== v) problemas.push(`${c}: guardado ${g}, real ${v}`)
  }
  for (const k of TIPOS_CONTA) {
    const g = guardado.byAccountKind?.[k] ?? 0
    const v = real.byAccountKind?.[k] ?? 0
    if (g !== v) problemas.push(`byAccountKind.${k}: guardado ${g}, real ${v}`)
  }

  return problemas
}

/**
 * A origem do mês, lida do rollup. Spec 003 §5 D3.
 *
 * Devolve `null` quando o rollup não sabe — mês vazio, ou agregado gravado
 * antes desta versão. Quem chama resolve a ausência com a lista de contas
 * (`origemDasContas`); confundir "não sei" com "é fatura" faria a tela sumir
 * com o saldo de quem só tem conta corrente e ainda não reimportou nada.
 */
export function origemDoRollup(rollup: Rollup): Origem | null {
  const contagem = rollup.byAccountKind ?? contagemPorTipoVazia()
  const somados = TIPOS_CONTA.reduce((total, k) => total + (contagem[k] ?? 0), 0)

  /**
   * A contagem só decide quando **cobre o período inteiro**.
   *
   * Rollup anterior à C2 nasce com a contagem zerada, e o delta de uma
   * importação nova soma **só as linhas novas**. Um período com receita de
   * conta corrente legada e uma compra de cartão recém-importada fica com
   * `count = 2` e `byAccountKind = { credit_card: 1 }` — a conta corrente
   * existe e não está contada.
   *
   * Decidir por essa contagem parcial devolveria `fatura`, e a tela sumiria
   * com a receita e o saldo de dinheiro que está lá. Devolver `null` manda a
   * decisão para a lista de contas, que é conservadora: quem tem conta
   * corrente continua vendo os números de conta.
   */
  if (somados < rollup.count) return null

  return origemDaContagem(contagem)
}

/**
 * As três leituras de gasto do mês, e elas fecham entre si:
 *
 *     bruto − estornos = líquido
 *
 * `gastoBrutoCents` é também, por construção, **a soma das fatias da pizza** —
 * é o que garante o critério de aceite da spec (§8: a soma das fatias bate com
 * o total ao centavo).
 */
export function gastoBrutoCents(rollup: Rollup): number {
  return Math.abs(rollup.totalOutCents)
}

export function totalRefundCents(rollup: Rollup): number {
  return rollup.totalRefundCents ?? 0
}

/**
 * Gasto líquido, e **sem piso em zero**.
 *
 * A versão anterior fazia `Math.max(0, …)`. Num mês em que o estorno supera a
 * compra — chargeback, devolução do mês anterior — isso mostrava
 * `Total gasto: R$ 0,00` e o dinheiro devolvido sumia também do saldo. Um mês
 * líquido-positivo é uma informação, não um estado inválido a ser escondido.
 */
export function totalNetExpenseCents(rollup: Rollup): number {
  return gastoBrutoCents(rollup) - totalRefundCents(rollup)
}

/**
 * Gasto por categoria já com o estorno abatido.
 *
 * O rollup guarda os dois brutos separados; quem precisa do líquido por
 * categoria — os insights, que comparam mês a mês — junta aqui, num lugar só.
 */
export function categoriasLiquidas(rollup: Rollup): PorCategoria {
  const liquido = porCategoriaVazio()
  for (const c of CATEGORIAS) {
    liquido[c] = (rollup.byCategory[c] ?? 0) + (rollup.refundByCategory?.[c] ?? 0)
  }
  return liquido
}

/** `2026-08-14` → `2026-08`. */
export function mesDe(occurredOn: string): string {
  return occurredOn.slice(0, 7)
}
