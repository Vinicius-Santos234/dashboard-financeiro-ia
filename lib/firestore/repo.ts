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
  await adminDb.doc(p.usuario(uid)).set(
    { email, criadoEm: FieldValue.serverTimestamp() },
    { merge: true }
  )
}

export type TipoConta = 'checking' | 'savings' | 'credit_card'

export async function criarConta(
  uid: string,
  dados: { name: string; institution?: string | null; kind: TipoConta }
): Promise<string> {
  const ref = adminDb.collection(p.contas(uid)).doc()
  await ref.set({
    name: dados.name,
    institution: dados.institution ?? null,
    kind: dados.kind,
    createdAt: FieldValue.serverTimestamp(),
  })
  return ref.id
}

export async function listarContas(uid: string) {
  const snap = await adminDb.collection(p.contas(uid)).get()
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
  const col = adminDb.collection(p.transacoes(uid))

  for (let i = 0; i < fingerprints.length; i += 30) {
    const pedaco = fingerprints.slice(i, i + 30)
    const refs = pedaco.map((fp) => col.doc(fp))
    const docs = await adminDb.getAll(...refs)
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
 * Grava o lote e atualiza os rollups dos meses tocados.
 *
 * `create()` em vez de `set()` é deliberado: se o documento já existe, a
 * escrita falha. É a deduplicação vindo da forma da árvore (§4.3) em vez de
 * uma constraint declarada — e é a segunda linha de defesa, já que
 * `separarDuplicadas` normalmente barra antes.
 */
export async function gravarTransacoes(
  uid: string,
  transacoes: readonly ComFingerprint[],
  opcoes: OpcoesGravacao
): Promise<ResultadoGravacao> {
  if (transacoes.length === 0) return { gravadas: 0, jaExistiam: 0 }

  const col = adminDb.collection(p.transacoes(uid))

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

  // Só o que REALMENTE entrou pode somar no rollup. Somar o lote inteiro
  // inflaria o gráfico a cada reimportação parcial — o mesmo estrago que a
  // deduplicação existe para evitar, entrando por outra porta.
  const gravadas: ComFingerprint[] = []
  let jaExistiam = 0

  // O batch do Firestore aceita 500 operações; 400 deixa margem.
  for (let i = 0; i < transacoes.length; i += 400) {
    const pedaco = transacoes.slice(i, i + 400)
    const batch = adminDb.batch()

    for (const t of pedaco) {
      batch.create(col.doc(t.fingerprint), {
        ...montar(t),
        createdAt: FieldValue.serverTimestamp(),
      })
    }

    try {
      await batch.commit()
      gravadas.push(...pedaco)
    } catch {
      // Um `create` que colide derruba o batch inteiro. Cai para uma por uma
      // para que uma duplicata não custe as outras 399.
      for (const t of pedaco) {
        try {
          await col
            .doc(t.fingerprint)
            .create({ ...montar(t), createdAt: FieldValue.serverTimestamp() })
          gravadas.push(t)
        } catch {
          jaExistiam += 1
        }
      }
    }
  }

  await somarNosRollups(
    uid,
    gravadas.map((t) => ({
      month: mesDe(t.occurredOn),
      amountCents: t.amountCents,
      category: null,
    }))
  )

  return { gravadas: gravadas.length, jaExistiam }
}

/** Aplica o delta de inserção em cada mês tocado, um `runTransaction` por mês. */
async function somarNosRollups(uid: string, linhas: readonly LinhaAgregavel[]) {
  const porMes = new Map<string, LinhaAgregavel[]>()
  for (const l of linhas) {
    const lista = porMes.get(l.month) ?? []
    lista.push(l)
    porMes.set(l.month, lista)
  }

  for (const [mes, doMes] of porMes) {
    const ref = adminDb.doc(p.rollup(uid, mes))
    await adminDb.runTransaction(async (tx) => {
      const atual = await tx.get(ref)
      const base = atual.exists ? (atual.data() as Rollup) : rollupVazio(mes)
      const novo = aplicarDelta(base, deltaDeInsercao(doMes))
      tx.set(ref, { ...novo, updatedAt: FieldValue.serverTimestamp() })
    })
  }
}

/** Muda a categoria de uma transação e move o valor no rollup, atomicamente. */
export async function recategorizar(
  uid: string,
  fingerprint: string,
  para: Categoria,
  origem: 'ai' | 'rule' | 'user',
  confidence: number | null = null
): Promise<void> {
  const txRef = adminDb.doc(p.transacao(uid, fingerprint))

  await adminDb.runTransaction(async (t) => {
    const snap = await t.get(txRef)
    if (!snap.exists) throw new Error(`Transação ${fingerprint} não existe.`)

    const dados = snap.data() as TransactionDoc
    if (dados.category === para) return

    const rollupRef = adminDb.doc(p.rollup(uid, dados.month))
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
  const snap = await adminDb.doc(p.rollup(uid, mes)).get()
  return snap.exists ? (snap.data() as Rollup) : rollupVazio(mes)
}

/**
 * Recomputa o rollup varrendo as transações do mês. Spec §4.5.
 *
 * É o botão de conserto para quando o incremental divergir — e a existência
 * dele é o que torna o cache aceitável. Um mês são ~100 documentos.
 */
export async function recalcularRollup(uid: string, mes: string): Promise<Rollup> {
  const snap = await adminDb
    .collection(p.transacoes(uid))
    .where('month', '==', mes)
    .get()

  const linhas: LinhaAgregavel[] = snap.docs.map((d) => {
    const t = d.data() as TransactionDoc
    return { month: t.month, amountCents: t.amountCents, category: t.category }
  })

  const novo = calcularRollup(mes, linhas)
  await adminDb
    .doc(p.rollup(uid, mes))
    .set({ ...novo, updatedAt: FieldValue.serverTimestamp() })

  return novo
}

export async function listarTransacoesDoMes(uid: string, mes: string) {
  const snap = await adminDb
    .collection(p.transacoes(uid))
    .where('month', '==', mes)
    .orderBy('occurredOn', 'desc')
    .get()

  return snap.docs.map((d) => ({ fingerprint: d.id, ...(d.data() as TransactionDoc) }))
}

export async function contarTransacoes(uid: string): Promise<number> {
  const snap = await adminDb.collection(p.transacoes(uid)).count().get()
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
  await adminDb.recursiveDelete(adminDb.doc(p.usuario(uid)))
}
