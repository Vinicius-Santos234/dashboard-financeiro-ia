import 'server-only'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import type { Categoria } from '@/lib/domain/categories'
import { normalizarPadrao, type RegraCategoria } from '@/lib/domain/rules'
import type { InsightBody } from '@/lib/llm/schema'
import { separarDuplicadas, type ComFingerprint } from '@/lib/domain/fingerprint'
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

export interface ImportDoc {
  accountId: string
  source: 'ofx' | 'csv'
  filename: string
  fileHash: string
  periodStart: string | null
  periodEnd: string | null
  rowsTotal: number
  rowsImported: number
  rowsDuplicated: number
  rowsDiscarded: number
  status: 'parsed' | 'categorized' | 'failed'
  error: string | null
}

export async function registrarImport(
  uid: string,
  dados: ImportDoc
): Promise<string> {
  const ref = adminDb().collection(p.importacoes(uid)).doc()
  await ref.set({ ...dados, createdAt: FieldValue.serverTimestamp() })
  return ref.id
}

export async function atualizarImport(
  uid: string,
  importId: string,
  dados: Partial<ImportDoc>
): Promise<void> {
  await adminDb().doc(p.importacao(uid, importId)).update(dados)
}

/**
 * Importações anteriores do mesmo arquivo, pelo sha256.
 *
 * Não bloqueia nada — reimportar é legítimo e quem impede linha duplicada é o
 * fingerprint. Serve para a tela poder dizer "você já importou este arquivo em
 * tal data", que é informação e não impedimento.
 */
export async function importsComMesmoHash(uid: string, fileHash: string) {
  const snap = await adminDb()
    .collection(p.importacoes(uid))
    .where('fileHash', '==', fileHash)
    .get()

  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ImportDoc) }))
}

export async function listarImports(uid: string) {
  const snap = await adminDb()
    .collection(p.importacoes(uid))
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ImportDoc & { createdAt?: { toDate(): Date } }) }))
}

/** A conta usada quando o extrato não identifica nenhuma. */
export async function contaPadrao(
  uid: string,
  sugestao: { name: string; institution?: string | null; kind: TipoConta }
): Promise<string> {
  const existentes = await adminDb()
    .collection(p.contas(uid))
    .where('name', '==', sugestao.name)
    .limit(1)
    .get()

  if (!existentes.empty) return existentes.docs[0].id
  return criarConta(uid, sugestao)
}

export interface ResultadoGravacao {
  gravadas: number
  jaExistiam: number
}

export interface OpcoesGravacao {
  accountId: string
  importId: string
  source: TransactionDoc['source']
  /** Descrição anonimizada (§7.1). */
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

        const existentes = docs.filter((d) => d.exists).map((d) => d.id)

        // Duplicata é decidida por LEITURA, não por capturar exceção. A versão
        // anterior fazia `catch { jaExistiam += 1 }`, que contava timeout e
        // indisponibilidade como "já existia" — linhas nunca gravadas sumiam do
        // relatório com o rótulo errado. Agora erro de infraestrutura sobe e
        // derruba o import, que é o comportamento honesto.
        //
        // A decisão em si é a mesma de `separarDuplicadas`, e é ela que roda —
        // não uma cópia. Reimplementar o casamento aqui faria os testes do
        // critério de aceite da E2 provarem uma função que o app não chama.
        const { novas, duplicadas } = separarDuplicadas(pedaco, existentes)

        if (novas.length === 0) {
          return { gravadas: 0, jaExistiam: duplicadas.length }
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
          jaExistiam: duplicadas.length,
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

export interface AtualizacaoCategoria {
  fingerprint: string
  month: string
  category: Categoria
  categorySource: 'ai' | 'rule' | 'user'
  confidence: number | null
  descriptionClean?: string
}

/**
 * Categoriza em lote e mantém o rollup na mesma transação. Fazer uma
 * transação por linha tornaria um extrato grande lento e caro; agrupar por mês
 * também garante que cada transação do Firestore toque um só rollup.
 */
export async function aplicarCategorias(
  uid: string,
  atualizacoes: readonly AtualizacaoCategoria[]
): Promise<void> {
  const porMes = new Map<string, AtualizacaoCategoria[]>()
  for (const atualizacao of atualizacoes) {
    const lista = porMes.get(atualizacao.month) ?? []
    lista.push(atualizacao)
    porMes.set(atualizacao.month, lista)
  }

  for (const [mes, doMes] of porMes) {
    for (let inicio = 0; inicio < doMes.length; inicio += LOTE) {
      const pedaco = doMes.slice(inicio, inicio + LOTE)
      const rollupRef = adminDb().doc(p.rollup(uid, mes))
      const referencias = pedaco.map((a) => adminDb().doc(p.transacao(uid, a.fingerprint)))

      await adminDb().runTransaction(async (tx) => {
        const [rollupSnap, ...documentos] = await tx.getAll(rollupRef, ...referencias)
        let novo = rollupSnap.exists
          ? (rollupSnap.data() as Rollup)
          : rollupVazio(mes)

        for (let indice = 0; indice < documentos.length; indice += 1) {
          const documento = documentos[indice]
          if (!documento.exists) continue

          const atualizacao = pedaco[indice]
          const anterior = documento.data() as TransactionDoc
          novo = aplicarDelta(novo, {
            totalInCents: 0,
            totalOutCents: 0,
            count: 0,
            byCategory: {
              ...porCategoriaVazio(),
              ...deltaDeRecategorizacao(
                anterior.amountCents,
                anterior.category,
                atualizacao.category
              ),
            },
          })

          tx.update(documento.ref, {
            category: atualizacao.category,
            categorySource: atualizacao.categorySource,
            confidence: atualizacao.confidence,
            ...(atualizacao.descriptionClean
              ? { descriptionClean: atualizacao.descriptionClean }
              : {}),
          })
        }

        tx.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })
      })
    }
  }
}

export async function listarTransacoesDoImport(uid: string, importId: string) {
  const snap = await adminDb()
    .collection(p.transacoes(uid))
    .where('importId', '==', importId)
    .get()

  return snap.docs.map((d) => ({ fingerprint: d.id, ...(d.data() as TransactionDoc) }))
}

export async function obterTransacao(uid: string, fingerprint: string) {
  const snap = await adminDb().doc(p.transacao(uid, fingerprint)).get()
  return snap.exists
    ? { fingerprint: snap.id, ...(snap.data() as TransactionDoc) }
    : null
}

export async function listarRegras(uid: string): Promise<RegraCategoria[]> {
  const snap = await adminDb().collection(p.regras(uid)).get()
  return snap.docs.map((d) => d.data() as RegraCategoria)
}

export async function salvarRegra(
  uid: string,
  pattern: string,
  category: Categoria
): Promise<string> {
  const normalizado = normalizarPadrao(pattern)
  if (normalizado.length < 3) throw new Error('O padrão precisa ter ao menos 3 caracteres.')

  const ref = adminDb().doc(p.regra(uid, p.idSeguro(normalizado)))
  await adminDb().runTransaction(async (tx) => {
    const atual = await tx.get(ref)
    tx.set(
      ref,
      {
        pattern: normalizado,
        category,
        hits: atual.exists ? ((atual.data()?.hits as number | undefined) ?? 0) : 0,
        ...(atual.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true }
    )
  })
  return normalizado
}

export async function incrementarHitsRegras(
  uid: string,
  padroes: readonly string[]
): Promise<void> {
  const contagem = new Map<string, number>()
  for (const padrao of padroes) contagem.set(padrao, (contagem.get(padrao) ?? 0) + 1)
  if (contagem.size === 0) return

  const batch = adminDb().batch()
  for (const [padrao, hits] of contagem) {
    batch.update(adminDb().doc(p.regra(uid, p.idSeguro(padrao))), {
      hits: FieldValue.increment(hits),
    })
  }
  await batch.commit()
}

export async function definirAiOptOut(
  uid: string,
  fingerprint: string,
  optOut: boolean
): Promise<void> {
  const ref = adminDb().doc(p.transacao(uid, fingerprint))
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new Error('Transação não encontrada.')
    const dados = snap.data() as TransactionDoc

    if (!optOut) {
      tx.update(ref, { aiOptOut: false })
      return
    }

    const rollupRef = adminDb().doc(p.rollup(uid, dados.month))
    const rollupSnap = await tx.get(rollupRef)
    const base = rollupSnap.exists
      ? (rollupSnap.data() as Rollup)
      : rollupVazio(dados.month)
    const novo = aplicarDelta(base, {
      totalInCents: 0,
      totalOutCents: 0,
      count: 0,
      byCategory: {
        ...porCategoriaVazio(),
        ...deltaDeRecategorizacao(dados.amountCents, dados.category, 'outros'),
      },
    })

    tx.update(ref, {
      aiOptOut: true,
      category: 'outros',
      categorySource: 'user',
      confidence: null,
    })
    tx.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })
  })
}

export async function lerRollup(uid: string, mes: string): Promise<Rollup> {
  const snap = await adminDb().doc(p.rollup(uid, mes)).get()
  return snap.exists ? (snap.data() as Rollup) : rollupVazio(mes)
}

export interface InsightDoc {
  body: InsightBody
  model: string
  generatedAt?: { toDate(): Date }
}

export async function lerInsight(uid: string, mes: string): Promise<InsightDoc | null> {
  const snap = await adminDb().doc(p.insight(uid, mes)).get()
  return snap.exists ? (snap.data() as InsightDoc) : null
}

export async function salvarInsight(
  uid: string,
  mes: string,
  body: InsightBody,
  model: string
): Promise<void> {
  await adminDb().doc(p.insight(uid, mes)).set({
    body,
    model,
    generatedAt: FieldValue.serverTimestamp(),
  })
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
