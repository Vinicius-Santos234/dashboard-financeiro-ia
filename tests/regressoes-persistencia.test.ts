import { beforeEach, describe, expect, it, vi } from 'vitest'
import { banco, documentos, limparBanco } from './helpers/firestore-memory'
import { atribuirFingerprints } from '@/lib/domain/fingerprint'
import {
  aplicarCategorias, definirAiOptOut, gravarTransacoes, lerRollup,
  listarTransacoesDoImport, obterTransacao, recategorizar, revalidarPendentes,
} from '@/lib/firestore/repo'
import { categorizarTransacoes, planejarCategorizacao } from '@/lib/llm/categorize'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: () => banco }))

const uid = 'pessoa-a'
const accountId = 'conta'
const a = { occurredOn: '2026-08-14', amountCents: -1000, description: 'COMPRA A', fitid: 'X' }
const b = { ...a, amountCents: -2000, description: 'COMPRA B' }

async function importar(linhas = [a], importId = 'original') {
  return gravarTransacoes(uid, atribuirFingerprints(accountId, linhas), {
    accountId, importId, source: 'ofx', descriptionClean: (t) => t.description,
  })
}

beforeEach(limparBanco)

describe('deduplicação pela persistência real do projeto', () => {
  it('único → repetido: só a compra B entra e o total não dobra', async () => {
    await importar()
    expect(await importar([a, b], 'segundo')).toEqual({ gravadas: 1, jaExistiam: 1 })
    expect(await lerRollup(uid, '2026-08')).toMatchObject({ count: 2, totalOutCents: -3000 })
    expect(await importar([a, b], 'terceiro')).toEqual({ gravadas: 0, jaExistiam: 2 })
    expect(await listarTransacoesDoImport(uid, 'original')).toHaveLength(1)
  })

  it('repetido → único: reconhece as duas compras nos imports seguintes', async () => {
    await importar([a, b])
    expect(await importar([a])).toEqual({ gravadas: 0, jaExistiam: 1 })
    expect(await importar([b])).toEqual({ gravadas: 0, jaExistiam: 1 })
  })

  it('reconhece documentos legados sem contentFingerprint', async () => {
    await importar()
    const [id] = atribuirFingerprints(accountId, [a])
    delete documentos.get(`users/${uid}/transactions/${id.fingerprint}`)!.contentFingerprint
    expect(await importar([a, b])).toEqual({ gravadas: 1, jaExistiam: 1 })
  })

  it('preserva duas compras idênticas e funciona entre lotes de 200', async () => {
    await importar()
    const linhas = Array.from({ length: 201 }, () => ({ ...a }))
    expect(await importar(linhas)).toEqual({ gravadas: 200, jaExistiam: 1 })
    expect(await importar(linhas)).toEqual({ gravadas: 0, jaExistiam: 201 })
    expect(await lerRollup(uid, '2026-08')).toMatchObject({ count: 201, totalOutCents: -201000 })
  })
})

describe('respostas atrasadas da IA', () => {
  async function preparar() {
    await importar()
    const [linha] = await listarTransacoesDoImport(uid, 'original')
    return { linha, resposta: {
      fingerprint: linha.fingerprint, month: linha.month,
      category: 'alimentacao' as const, categorySource: 'ai' as const,
      confidence: 0.9, expectedRevision: linha.categoryRevision ?? 0,
    } }
  }

  it('preserva correção manual e o rollup', async () => {
    const { linha, resposta } = await preparar()
    await recategorizar(uid, linha.fingerprint, 'saude', 'user')
    expect(await aplicarCategorias(uid, [resposta])).toEqual([])
    expect(await obterTransacao(uid, linha.fingerprint)).toMatchObject({ category: 'saude', categorySource: 'user' })
    expect((await lerRollup(uid, linha.month)).byCategory.saude).toBe(-1000)
    expect((await lerRollup(uid, linha.month)).byCategory.alimentacao).toBe(0)
  })

  it('preserva opt-out, mesmo quando foi desfeito durante a espera', async () => {
    const { linha, resposta } = await preparar()
    await definirAiOptOut(uid, linha.fingerprint, true)
    expect(await aplicarCategorias(uid, [resposta])).toEqual([])
    await definirAiOptOut(uid, linha.fingerprint, false)
    expect(await aplicarCategorias(uid, [resposta])).toEqual([])
    const atual = await obterTransacao(uid, linha.fingerprint)
    expect(atual).toMatchObject({ category: null, aiOptOut: false, categoryRevision: 2 })
    expect(await aplicarCategorias(uid, [{ ...resposta, expectedRevision: 2 }])).toEqual([linha.fingerprint])
  })

  it('revalidar retira do payload uma linha alterada após o planejamento', async () => {
    const { linha } = await preparar()
    const plano = planejarCategorizacao([linha], [])
    await definirAiOptOut(uid, linha.fingerprint, true)
    const provider = { model: 'fake', categorizar: vi.fn(), gerarInsight: vi.fn() }
    expect(await categorizarTransacoes(plano, provider, (lote) => revalidarPendentes(uid, lote))).toEqual([])
    expect(provider.categorizar).not.toHaveBeenCalled()
  })

  it('uma resposta repetida não move o rollup duas vezes', async () => {
    const { linha, resposta } = await preparar()
    expect(await aplicarCategorias(uid, [resposta])).toEqual([linha.fingerprint])
    expect(await aplicarCategorias(uid, [resposta])).toEqual([])
    expect((await lerRollup(uid, linha.month)).byCategory.alimentacao).toBe(-1000)
  })
})
