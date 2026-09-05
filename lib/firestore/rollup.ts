import { CATEGORIAS, type Categoria } from '@/lib/domain/categories'

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
  totalOutCents: number
  count: number
  byCategory: PorCategoria
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
    count: 0,
    byCategory: porCategoriaVazio(),
  }
}

export interface LinhaAgregavel {
  month: string
  amountCents: number
  category: Categoria | null
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

    r.count += 1
    if (linha.amountCents >= 0) r.totalInCents += linha.amountCents
    else r.totalOutCents += linha.amountCents

    // Transação ainda não categorizada conta em `outros` para o total do
    // gráfico nunca ficar menor que o total do extrato. Quando a IA
    // categorizar, o delta move o valor de `outros` para a categoria certa.
    const categoria = linha.category ?? 'outros'
    r.byCategory[categoria] += linha.amountCents
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
  const d = { totalInCents: 0, totalOutCents: 0, count: 0, byCategory: porCategoriaVazio() }

  for (const linha of linhas) {
    d.count += 1
    if (linha.amountCents >= 0) d.totalInCents += linha.amountCents
    else d.totalOutCents += linha.amountCents
    d.byCategory[linha.category ?? 'outros'] += linha.amountCents
  }

  return d
}

/**
 * O delta de uma recategorização: tira o valor de onde estava e põe onde
 * passou a estar. Os totais não mudam — só a divisão entre categorias.
 */
export function deltaDeRecategorizacao(
  amountCents: number,
  de: Categoria | null,
  para: Categoria
): Partial<PorCategoria> {
  const anterior = de ?? 'outros'
  if (anterior === para) return {}

  return {
    [anterior]: -amountCents,
    [para]: amountCents,
  } as Partial<PorCategoria>
}

export function aplicarDelta(base: Rollup, delta: Omit<Rollup, 'month'>): Rollup {
  const byCategory = porCategoriaVazio()
  for (const c of CATEGORIAS) {
    byCategory[c] = (base.byCategory[c] ?? 0) + (delta.byCategory[c] ?? 0)
  }

  return {
    month: base.month,
    totalInCents: base.totalInCents + delta.totalInCents,
    totalOutCents: base.totalOutCents + delta.totalOutCents,
    count: base.count + delta.count,
    byCategory,
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
  for (const c of CATEGORIAS) {
    const g = guardado.byCategory[c] ?? 0
    const v = real.byCategory[c] ?? 0
    if (g !== v) problemas.push(`${c}: guardado ${g}, real ${v}`)
  }

  return problemas
}

/** `2026-08-14` → `2026-08`. */
export function mesDe(occurredOn: string): string {
  return occurredOn.slice(0, 7)
}
