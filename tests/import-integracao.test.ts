import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ofxAdapter } from '@/lib/sources/ofx'
import { atribuirFingerprints } from '@/lib/domain/fingerprint'
import { divergencias, calcularRollup, type LinhaAgregavel } from '@/lib/firestore/rollup'

/**
 * O critério de aceite da E2 (spec §8), contra o Firestore de verdade.
 *
 * Os testes de `fingerprint.test.ts` provam a aritmética da deduplicação em
 * memória. Este prova o caminho inteiro: gravação transacional, rollup, e o
 * que acontece quando o mesmo arquivo entra duas vezes.
 *
 * **Pula em CI de propósito.** Precisa da chave de serviço do Admin SDK, que é
 * a credencial mais poderosa do projeto — ela não vai para os secrets de um
 * repositório público só para um teste rodar lá. Roda localmente, onde a chave
 * já existe.
 */

const temAdmin = Boolean(
  process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY &&
    process.env.TEST_USER_A_UID
)

const UID = process.env.TEST_USER_A_UID ?? ''
const CONTA = 'conta-teste-integracao'
const MES = '2026-08'

function fixture(nome: string): ArrayBuffer {
  const buf = readFileSync(resolve(__dirname, 'fixtures/derivadas', nome))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe.skipIf(!temAdmin)('import de ponta a ponta', () => {
  let repo: typeof import('@/lib/firestore/repo')
  let paths: typeof import('@/lib/firestore/paths')
  let adminDb: typeof import('@/lib/firebase/admin').adminDb

  async function limpar() {
    const db = adminDb()
    // Só as transações desta conta de teste — não toca no que o teste de
    // isolamento gravou.
    const snap = await db
      .collection(paths.transacoes(UID))
      .where('accountId', '==', CONTA)
      .get()

    for (const d of snap.docs) await d.ref.delete()
    await db.doc(paths.rollup(UID, MES)).delete().catch(() => {})
  }

  beforeAll(async () => {
    repo = await import('@/lib/firestore/repo')
    paths = await import('@/lib/firestore/paths')
    adminDb = (await import('@/lib/firebase/admin')).adminDb
    await limpar()
  }, 60_000)

  afterAll(async () => {
    await limpar()
  }, 60_000)

  it('importa, e o rollup bate com as transações gravadas', async () => {
    const lido = await ofxAdapter.parse(fixture('conta-corrente.ofx'), undefined)
    const lote = atribuirFingerprints(CONTA, lido.transactions)

    const r = await repo.gravarTransacoes(UID, lote, {
      accountId: CONTA,
      importId: 'import-teste',
      source: 'ofx',
      descriptionClean: (t) => t.description,
    })

    expect(r.gravadas).toBe(5)
    expect(r.jaExistiam).toBe(0)

    const rollup = await repo.lerRollup(UID, MES)
    expect(rollup.count).toBe(5)

    // A fixture: +3.200,00 de salário; -47,90 iFood; -8,00 e -8,00 dos dois
    // cafés do mesmo dia; -50,00 do PIX.
    expect(rollup.totalInCents).toBe(320000)
    expect(rollup.totalOutCents).toBe(-4790 - 800 - 800 - 5000)

    // Nada foi categorizado ainda, então tudo cai em `outros` — assim o total
    // do gráfico nunca fica menor que o do extrato só porque a IA não rodou.
    expect(rollup.byCategory.outros).toBe(320000 - 4790 - 800 - 800 - 5000)
  }, 60_000)

  it('o rollup incremental bate com o recálculo do zero', async () => {
    // A defesa obrigatória do §4.5: o cache não pode divergir da verdade.
    const guardado = await repo.lerRollup(UID, MES)

    const transacoes = await repo.listarTransacoesDoMes(UID, MES)
    const linhas: LinhaAgregavel[] = transacoes
      .filter((t) => t.accountId === CONTA)
      .map((t) => ({
        month: t.month,
        amountCents: t.amountCents,
        category: t.category,
      }))

    expect(divergencias(guardado, calcularRollup(MES, linhas))).toEqual([])
  }, 60_000)

  it('reimportar o mesmo arquivo não grava nada E não mexe no rollup', async () => {
    // O critério de aceite da E2. A segunda metade é o que a versão anterior
    // do código quebrava: mesmo sem gravar transação nova, ela somava o lote
    // inteiro no agregado e inflava o gráfico a cada reimportação.
    const antes = await repo.lerRollup(UID, MES)

    const lido = await ofxAdapter.parse(fixture('conta-corrente.ofx'), undefined)
    const lote = atribuirFingerprints(CONTA, lido.transactions)

    const r = await repo.gravarTransacoes(UID, lote, {
      accountId: CONTA,
      importId: 'import-teste-2',
      source: 'ofx',
      descriptionClean: (t) => t.description,
    })

    expect(r.gravadas).toBe(0)
    expect(r.jaExistiam).toBe(5)

    const depois = await repo.lerRollup(UID, MES)
    expect(divergencias(depois, antes)).toEqual([])
  }, 60_000)

  it('recategorizar move o valor sem mexer nos totais', async () => {
    const transacoes = await repo.listarTransacoesDoMes(UID, MES)
    const alvo = transacoes.find(
      (t) => t.accountId === CONTA && t.amountCents === -4790
    )
    expect(alvo).toBeDefined()

    const antes = await repo.lerRollup(UID, MES)
    await repo.recategorizar(UID, alvo!.fingerprint, 'alimentacao', 'user')
    const depois = await repo.lerRollup(UID, MES)

    expect(depois.totalInCents).toBe(antes.totalInCents)
    expect(depois.totalOutCents).toBe(antes.totalOutCents)
    expect(depois.count).toBe(antes.count)
    expect(depois.byCategory.alimentacao).toBe(
      antes.byCategory.alimentacao + -4790
    )
    expect(depois.byCategory.outros).toBe(antes.byCategory.outros - -4790)
  }, 60_000)

  it('e depois de recategorizar, o recálculo continua batendo', async () => {
    const guardado = await repo.lerRollup(UID, MES)

    const transacoes = await repo.listarTransacoesDoMes(UID, MES)
    const linhas: LinhaAgregavel[] = transacoes
      .filter((t) => t.accountId === CONTA)
      .map((t) => ({
        month: t.month,
        amountCents: t.amountCents,
        category: t.category,
      }))

    expect(divergencias(guardado, calcularRollup(MES, linhas))).toEqual([])
  }, 60_000)
})

describe.skipIf(temAdmin)('import de ponta a ponta — sem credencial de Admin', () => {
  it('avisa em vez de passar em silêncio', () => {
    console.warn(
      '\n[import-integracao.test.ts] PULADO: faltam FIREBASE_CLIENT_EMAIL / ' +
        'FIREBASE_PRIVATE_KEY / TEST_USER_A_UID. Esperado em CI (a chave de ' +
        'serviço não vai para secrets de repositório público).\n'
    )
    expect(temAdmin).toBe(false)
  })
})
