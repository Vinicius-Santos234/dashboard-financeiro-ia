import 'server-only'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import type { Categoria } from '@/lib/domain/categories'
import type { ComFingerprint } from '@/lib/domain/fingerprint'
import * as p from './paths'
import {
  aplicarDelta,
  calcularRollup,
  deltaDeInsercao,
  deltaDeRecategorizacao,
  mesDe,
  porCategoriaVazio,
  rollupVazio,
  type LinhaAgregavel,
  type Rollup,
} from './rollup'

/**
 * Todo acesso do servidor ao Firestore passa por aqui. Spec §3.1.
 *
 * A regra que não se quebra: **`uid` é o primeiro argumento de tudo**, e o
 * caminho é montado a partir dele. O Admin SDK ignora as Security Rules, então
 * não existe rede de proteção embaixo — a proteção é não haver como escrever
 * uma query sem dizer de quem são os dados.
 */

export interface TransactionDoc {
  accountId: string
  importId: string | null
  occurredOn: string
  month: string
  amountCents: number
  descriptionRaw: string
  descriptionClean: string
  fitid: string | null
  category: Categoria | null
  categorySource: 'ai' | 'rule' | 'user' | null
  confidence: number | null
  source: 'ofx' | 'csv' | 'bot' | 'openfinance'
  aiOptOut: boolean
}

export async function garantirUsuario(uid: string, email: string | null) {
  await adminDb().doc(p.usuario(uid)).set(
    { email, criadoEm: FieldValue.serverTimestamp() },
    { merge: true }
  )
}

export type TipoConta = 'checking' | 'savings' | 'credit_card'

export async function criarConta(
  uid: string,
  dados: { name: string; institution?: string | null; kind: TipoConta }
): Promise<string> {
  const ref = adminDb().collection(p.contas(uid)).doc()
  await ref.set({
    name: dados.name,
    institution: dados.institution ?? null,
    kind: dados.kind,
    createdAt: FieldValue.serverTimestamp(),
  })
  return ref.id
}

export async function listarContas(uid: string) {
  const snap = await adminDb().collection(p.contas(uid)).get()
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/**
 * Quais destes fingerprints já existem.
 *
 * O Firestore limita `in` a 30 valores por query, então o lote é quebrado. É
 * mais barato que ler o mês inteiro e comparar em memória quando o import é
 * pequeno, e a alternativa (tentar gravar e ver quem falha) desperdiça escrita,
 * que é o que custa caro no Firestore.
 */
export async function fingerprintsExistentes(
  uid: string,
  fingerprints: readonly string[]
): Promise<Set<string>> {
  const achados = new Set<string>()
  const col = adminDb().collection(p.transacoes(uid))

  for (let i = 0; i < fingerprints.length; i += 30) {
    const pedaco = fingerprints.slice(i, i + 30)
    const refs = pedaco.map((fp) => col.doc(fp))
    const docs = await adminDb().getAll(...refs)
    for (const d of docs) if (d.exists) achados.add(d.id)
  }

  return achados
}

export interface ResultadoGravacao {
  gravadas: number
  jaExistiam: number
}

export interface OpcoesGravacao {
  accountId: string
  importId: string
  source: TransactionDoc['source']
  /** Descrição anonimizada (§7.1). Na E2 ainda é a própria descrição. */
  descriptionClean: (t: ComFingerprint) => string
}

/**
 * Uma transação do Firestore aceita 500 operações. Aqui são, por lote:
 * N leituras + N escritas + 1 leitura e 1 escrita do rollup. 200 cabe com
 * folga e mantém a transação curta, o que reduz retentativa por contenção.
 */
const LOTE = 200

/**
 * Grava o lote **e** atualiza o rollup do mês na MESMA transação. Spec §4.5.
 *
 * A versão anterior gravava as transações num batch e só depois somava o
 * rollup, em outra operação. Uma falha entre as duas deixava as transações
 * gravadas e o agregado sem elas — e, pior, a reimportação encontrava as
 * linhas como duplicadas, de modo que o rollup **nunca** as receberia. A
 * divergência era permanente e silenciosa.
 *
 * O agrupamento por mês existe porque o rollup é por mês: cada transação do
 * Firestore toca um único documento de agregado.
 */
export async function gravarTransacoes(
  uid: string,
  transacoes: readonly ComFingerprint[],
  opcoes: OpcoesGravacao
): Promise<ResultadoGravacao> {
  if (transacoes.length === 0) return { gravadas: 0, jaExistiam: 0 }

  const col = adminDb().collection(p.transacoes(uid))

  const montar = (t: ComFingerprint): TransactionDoc => ({
    accountId: opcoes.accountId,
    importId: opcoes.importId,
    occurredOn: t.occurredOn,
    month: mesDe(t.occurredOn),
    amountCents: t.amountCents,
    descriptionRaw: t.description,
    descriptionClean: opcoes.descriptionClean(t),
    fitid: t.fitid ?? null,
    category: null,
    categorySource: null,
    confidence: null,
    source: opcoes.source,
    aiOptOut: false,
  })

  const porMes = new Map<string, ComFingerprint[]>()
  for (const t of transacoes) {
    const mes = mesDe(t.occurredOn)
    const lista = porMes.get(mes) ?? []
    lista.push(t)
    porMes.set(mes, lista)
  }

  let gravadas = 0
  let jaExistiam = 0

  for (const [mes, doMes] of porMes) {
    const rollupRef = adminDb().doc(p.rollup(uid, mes))

    for (let i = 0; i < doMes.length; i += LOTE) {
      const pedaco = doMes.slice(i, i + LOTE)

      const parcial = await adminDb().runTransaction(async (tx) => {
        // Checa o fingerprint E os alternativos: a mesma transação pode estar
        // gravada sob a outra forma de identidade, se um arquivo anterior a
        // classificou de outro jeito (ComFingerprint.alternativos).
        const ids = [
          ...new Set(pedaco.flatMap((t) => [t.fingerprint, ...t.alternativos])),
        ]

        // No Firestore, TODA leitura vem antes de TODA escrita.
        const [rollupSnap, ...docs] = await tx.getAll(
          rollupRef,
          ...ids.map((id) => col.doc(id))
        )

        const existentes = new Set(
          docs.filter((d) => d.exists).map((d) => d.id)
        )

        // Duplicata é decidida por LEITURA, não por capturar exceção. A versão
        // anterior fazia `catch { jaExistiam += 1 }`, que contava timeout e
        // indisponibilidade como "já existia" — linhas nunca gravadas sumiam do
        // relatório com o rótulo errado. Agora erro de infraestrutura sobe e
        // derruba o import, que é o comportamento honesto.
        const novas = pedaco.filter(
          (t) =>
            !existentes.has(t.fingerprint) &&
            !t.alternativos.some((id) => existentes.has(id))
        )

        if (novas.length === 0) {
          return { gravadas: 0, jaExistiam: pedaco.length }
        }

        const base = rollupSnap.exists
          ? (rollupSnap.data() as Rollup)
          : rollupVazio(mes)

        const novo = aplicarDelta(
          base,
          deltaDeInsercao(
            novas.map((t) => ({
              month: mes,
              amountCents: t.amountCents,
              category: null,
            }))
          )
        )

        for (const t of novas) {
          tx.create(col.doc(t.fingerprint), {
            ...montar(t),
            createdAt: FieldValue.serverTimestamp(),
          })
        }
        tx.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })

        return {
          gravadas: novas.length,
          jaExistiam: pedaco.length - novas.length,
        }
      })

      gravadas += parcial.gravadas
      jaExistiam += parcial.jaExistiam
    }
  }

  return { gravadas, jaExistiam }
}

/** Muda a categoria de uma transação e move o valor no rollup, atomicamente. */
export async function recategorizar(
  uid: string,
  fingerprint: string,
  para: Categoria,
  origem: 'ai' | 'rule' | 'user',
  confidence: number | null = null
): Promise<void> {
  const txRef = adminDb().doc(p.transacao(uid, fingerprint))

  await adminDb().runTransaction(async (t) => {
    const snap = await t.get(txRef)
    if (!snap.exists) throw new Error(`Transação ${fingerprint} não existe.`)

    const dados = snap.data() as TransactionDoc
    if (dados.category === para) return

    const rollupRef = adminDb().doc(p.rollup(uid, dados.month))
    const rollupSnap = await t.get(rollupRef)
    const base = rollupSnap.exists
      ? (rollupSnap.data() as Rollup)
      : rollupVazio(dados.month)

    const delta = deltaDeRecategorizacao(dados.amountCents, dados.category, para)
    const novo = aplicarDelta(base, {
      totalInCents: 0,
      totalOutCents: 0,
      count: 0,
      byCategory: { ...porCategoriaVazio(), ...delta },
    })

    t.update(txRef, { category: para, categorySource: origem, confidence })
    t.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })
  })
}

export async function lerRollup(uid: string, mes: string): Promise<Rollup> {
  const snap = await adminDb().doc(p.rollup(uid, mes)).get()
  return snap.exists ? (snap.data() as Rollup) : rollupVazio(mes)
}

/**
 * Recomputa o rollup varrendo as transações do mês. Spec §4.5.
 *
 * É o botão de conserto para quando o incremental divergir — e a existência
 * dele é o que torna o cache aceitável. Um mês são ~100 documentos.
 *
 * Roda **dentro de uma transação** e não como leitura seguida de escrita. Sem
 * isso, a ferramenta de conserto conseguia corromper: o recálculo lia 99
 * transações, uma importação concorrente gravava a centésima e aplicava o
 * delta dela, e então o recálculo gravava o agregado das 99 — apagando a
 * centésima do gráfico. A transação do Firestore trava os documentos lidos
 * pela query, então a escrita concorrente força a retentativa em vez de ser
 * silenciosamente descartada.
 */
export async function recalcularRollup(uid: string, mes: string): Promise<Rollup> {
  const query = adminDb()
    .collection(p.transacoes(uid))
    .where('month', '==', mes)

  const rollupRef = adminDb().doc(p.rollup(uid, mes))

  return await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(query)

    const linhas: LinhaAgregavel[] = snap.docs.map((d) => {
      const t = d.data() as TransactionDoc
      return { month: t.month, amountCents: t.amountCents, category: t.category }
    })

    const novo = calcularRollup(mes, linhas)
    tx.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })

    return novo
  })
}

export async function listarTransacoesDoMes(uid: string, mes: string) {
  const snap = await adminDb()
    .collection(p.transacoes(uid))
    .where('month', '==', mes)
    .orderBy('occurredOn', 'desc')
    .get()

  return snap.docs.map((d) => ({ fingerprint: d.id, ...(d.data() as TransactionDoc) }))
}

export async function contarTransacoes(uid: string): Promise<number> {
  const snap = await adminDb().collection(p.transacoes(uid)).count().get()
  return snap.data().count
}

/**
 * Apaga a conta e tudo que está embaixo dela. Spec §7.4 (LGPD).
 *
 * `recursiveDelete` existe exatamente para isso e apaga subcoleções — que um
 * `delete` no documento não faria: no Firestore, apagar o pai deixa os filhos
 * órfãos e ainda legíveis por caminho direto. Esse é o erro clássico de
 * "apagamos a conta" que não apaga nada.
 */
export async function apagarTudoDoUsuario(uid: string): Promise<void> {
  await adminDb().recursiveDelete(adminDb().doc(p.usuario(uid)))
}
