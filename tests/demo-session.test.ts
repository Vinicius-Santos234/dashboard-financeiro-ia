import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { criarSessao, criarSessaoDemo, encerrarSessao, exigirSessaoGravavel, lerSessao } from '@/lib/firebase/session'

const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  getUser: vi.fn(), getUserByEmail: vi.fn(), verifyIdToken: vi.fn(),
  verifySessionCookie: vi.fn(), createSessionCookie: vi.fn(), revokeRefreshTokens: vi.fn(),
}))
vi.mock('@/lib/firebase/admin', () => ({ adminAuth: () => mocks }))
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: () => mocks.cookie ? { value: mocks.cookie } : undefined,
  set: (_nome: string, valor: string) => { mocks.cookie = valor },
  delete: () => { mocks.cookie = undefined },
}) }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('FIREBASE_DEMO_UID', 'demo-fixa')
  vi.stubEnv('NEXT_PUBLIC_DEMO_EMAIL', 'demo@exemplo.com')
  mocks.cookie = undefined
  mocks.getUser.mockResolvedValue({ uid: 'demo-fixa', email: 'demo@exemplo.com', disabled: true })
})
afterEach(() => vi.unstubAllEnvs())

describe('demo sem credenciais de autenticação', () => {
  it('abre acesso somente de leitura sem emitir tokens Firebase', async () => {
    await criarSessaoDemo()
    expect(await lerSessao()).toEqual({ uid: 'demo-fixa', email: 'demo@exemplo.com', demo: true })
    expect(mocks.verifyIdToken).not.toHaveBeenCalled()
    expect(mocks.createSessionCookie).not.toHaveBeenCalled()
    await expect(exigirSessaoGravavel()).rejects.toThrow('demonstração')
    await encerrarSessao()
    expect(mocks.cookie).toBeUndefined()
    expect(mocks.revokeRefreshTokens).not.toHaveBeenCalled()
  })

  it('recusa demo cujo login por senha ainda está habilitado', async () => {
    mocks.getUser.mockResolvedValue({ uid: 'demo-fixa', disabled: false })
    await expect(criarSessaoDemo()).rejects.toThrow('migrar:demo')
    expect(mocks.cookie).toBeUndefined()
  })

  it('não aceita token antigo nem cookie antigo da demo', async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: 'demo-fixa', email: 'email-alterado@exemplo.com' })
    await expect(criarSessao('token-antigo')).rejects.toThrow('demonstração')
    mocks.cookie = 'cookie-antigo'
    mocks.verifySessionCookie.mockResolvedValue({ uid: 'demo-fixa', email: 'email-alterado@exemplo.com' })
    expect(await lerSessao()).toBeNull()
  })

  it('não transforma cookie arbitrário em acesso a uma conta', async () => {
    mocks.cookie = 'demo-readonly-v1/outra-pessoa'
    mocks.verifySessionCookie.mockRejectedValue(new Error('assinatura inválida'))
    expect(await lerSessao()).toBeNull()
  })

  it('mantém verificação de revogação nas contas pessoais', async () => {
    mocks.cookie = 'cookie-pessoal'
    mocks.verifySessionCookie.mockResolvedValue({ uid: 'pessoa', email: 'pessoa@exemplo.com' })
    expect(await exigirSessaoGravavel()).toMatchObject({ uid: 'pessoa', demo: false })
    expect(mocks.verifySessionCookie).toHaveBeenCalledWith('cookie-pessoal', true)
  })
})
