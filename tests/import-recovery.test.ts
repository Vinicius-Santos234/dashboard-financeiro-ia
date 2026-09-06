import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { banco, limparBanco } from './helpers/firestore-memory'
import { POST as importar } from '@/app/api/imports/route'
import { POST as categorizar } from '@/app/api/categorize/route'
import { definirAiOptOut, listarTransacoesDoMes, obterTransacao, recategorizar } from '@/lib/firestore/repo'
import { ContaDemoError } from '@/lib/domain/demo'
import type { EntradaCategoriaLlm } from '@/lib/llm/provider'

const contexto = vi.hoisted(() => ({ uid: 'pessoa-a', demo: false, falhaAuth: false, categorizar: vi.fn(), cota: vi.fn() }))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: () => banco }))
vi.mock('@/lib/firebase/session', () => ({
  exigirSessao: async () => ({ uid: contexto.uid, demo: contexto.demo }),
  exigirSessaoGravavel: async () => {
    if (contexto.falhaAuth) throw new Error('Sem sessão')
    if (contexto.demo) throw new ContaDemoError()
    return { uid: contexto.uid, demo: false }
  },
}))
vi.mock('@/lib/llm/gemini', () => ({ GeminiProvider: class {
  model = 'fake'
  categorizar = contexto.categorizar
} }))
vi.mock('@/lib/firestore/quota', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/firestore/quota')>(),
  consumirCotaLlm: contexto.cota,
}))

beforeEach(() => {
  limparBanco()
  contexto.uid = 'pessoa-a'
  contexto.demo = false
  contexto.falhaAuth = false
  contexto.cota.mockReset()
  contexto.categorizar.mockReset().mockImplementation(async (linhas: EntradaCategoriaLlm[]) =>
    linhas.map((t) => ({ id: t.id, category: 'alimentacao', confidence: 0.9 })))
})
afterEach(() => vi.restoreAllMocks())

async function enviarExtrato() {
  const body = new FormData()
  body.set('arquivo', new File(['Data;Descricao;Valor\n14/08/2026;PADARIA;-10,00\n15/08/2026;CLINICA;-20,00'], 'extrato.csv'))
  body.set('source', 'csv')
  body.set('financialProfile', 'bank_account')
  body.set('mapping', JSON.stringify({
    colunaData: 'Data', colunaDescricao: 'Descricao', colunaValor: 'Valor', formatoData: 'dd/mm/yyyy',
  }))
  return importar(new Request('http://localhost/api/imports', { method: 'POST', body }))
}

function solicitar(dados: object = { month: '2026-08', confirmarEnvio: true }) {
  return categorizar(new Request('http://localhost/api/categorize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados),
  }))
}

describe('revisão antes da IA e recuperação sem reimportar', () => {
  it('importa sem IA e recusa categorização sem confirmação', async () => {
    expect((await enviarExtrato()).status).toBe(200)
    expect(contexto.categorizar).not.toHaveBeenCalled()
    expect(contexto.cota).not.toHaveBeenCalled()
    expect((await solicitar({ month: '2026-08' })).status).toBe(400)
    expect(contexto.categorizar).not.toHaveBeenCalled()
  })

  it('opt-out antes da confirmação impede o primeiro envio', async () => {
    await enviarExtrato()
    const clinica = (await listarTransacoesDoMes(contexto.uid, '2026-08')).find((t) => t.descriptionRaw === 'CLINICA')!
    await definirAiOptOut(contexto.uid, clinica.fingerprint, true)
    const resposta = await solicitar()
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toMatchObject({ total: 1, porIa: 1 })
    expect(JSON.stringify(contexto.categorizar.mock.calls)).not.toContain('CLINICA')
    expect(await obterTransacao(contexto.uid, clinica.fingerprint)).toMatchObject({ category: 'outros', aiOptOut: true })
  })

  it('reimportação deduplicada não impede recuperar a importação original', async () => {
    const primeiro = await (await enviarExtrato()).json()
    const repetido = await (await enviarExtrato()).json()
    expect(repetido).toMatchObject({ importadas: 0, duplicadas: 2 })
    expect(repetido.importId).not.toBe(primeiro.importId)
    expect(await (await solicitar()).json()).toMatchObject({ total: 2 })
    const linhas = await listarTransacoesDoMes(contexto.uid, '2026-08')
    expect(linhas.every((t) => t.importId === primeiro.importId && t.category === 'alimentacao')).toBe(true)
  })

  it('permite repetir após falha do provedor e não reenvia linhas já categorizadas', async () => {
    await enviarExtrato()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    contexto.categorizar.mockRejectedValueOnce(new Error('indisponível'))
    expect((await solicitar()).status).toBe(502)
    expect(await (await solicitar()).json()).toMatchObject({ total: 2 })
    expect(await (await solicitar()).json()).toMatchObject({ total: 0 })
    expect(contexto.categorizar).toHaveBeenCalledTimes(2)
  })

  it('relata somente categorias aplicadas quando ocorre edição durante a chamada', async () => {
    await enviarExtrato()
    const [linha] = await listarTransacoesDoMes(contexto.uid, '2026-08')
    contexto.categorizar.mockImplementationOnce(async (linhas: EntradaCategoriaLlm[]) => {
      await recategorizar(contexto.uid, linha.fingerprint, 'saude', 'user')
      return linhas.map((t) => ({ id: t.id, category: 'alimentacao', confidence: 0.9 }))
    })
    expect(await (await solicitar()).json()).toMatchObject({ total: 1, preservadas: 1 })
    expect(await obterTransacao(contexto.uid, linha.fingerprint)).toMatchObject({ category: 'saude', categorySource: 'user' })
  })

  it('recusa demo, sessão ausente e import de outro usuário', async () => {
    const original = await (await enviarExtrato()).json()
    contexto.demo = true
    expect((await solicitar()).status).toBe(403)
    contexto.demo = false
    contexto.falhaAuth = true
    expect((await solicitar()).status).toBe(401)
    contexto.falhaAuth = false
    contexto.uid = 'outra-pessoa'
    expect((await solicitar({ importId: original.importId, confirmarEnvio: true })).status).toBe(404)
    expect(await (await solicitar()).json()).toMatchObject({ total: 0 })
    expect(contexto.categorizar).not.toHaveBeenCalled()
  })
})
