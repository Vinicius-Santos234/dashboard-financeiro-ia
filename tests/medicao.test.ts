import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { semQueryString } from '@/lib/privacy/medicao'
import {
  CHAVE_CONSENTIMENTO,
  PADRAO_ANTES_DE_DECIDIR,
  gravarConsentimento,
  lerConsentimento,
  limparConsentimento,
  podeMedir,
} from '@/lib/privacy/consentimento'
import { CATEGORIAS } from '@/lib/domain/categories'

/**
 * A fronteira da medição. O irmão do teste do anonimizador: aqui se prova que
 * o que sai para a Vercel não carrega filtro de tela.
 */
describe('o que o Vercel Web Analytics recebe', () => {
  it('corta a categoria da URL — dado sensível na LGPD', () => {
    expect(
      semQueryString({ url: 'https://app.exemplo/transacoes?mes=2026-09&categoria=saude' })
    ).toEqual({ url: 'https://app.exemplo/transacoes' })
  })

  it('corta a query inteira, e não só os parâmetros que alguém lembrou', () => {
    // A garantia que uma lista de proibidos não dá: um filtro futuro já nasce
    // coberto.
    expect(
      semQueryString({ url: 'https://app.exemplo/x?fornecedor=CLINICA+X&qualquer=coisa' })
    ).toEqual({ url: 'https://app.exemplo/x' })
  })

  it('nenhuma das dez categorias sobrevive na URL enviada', () => {
    for (const categoria of CATEGORIAS) {
      const enviado = semQueryString({
        url: `https://app.exemplo/transacoes?mes=2026-09&categoria=${categoria}`,
      })
      expect(enviado?.url).toBe('https://app.exemplo/transacoes')
      expect(enviado?.url).not.toContain(categoria)
    }
  })

  it('corta o fragmento também', () => {
    expect(semQueryString({ url: 'https://app.exemplo/conta#renda' })).toEqual({
      url: 'https://app.exemplo/conta',
    })
  })

  it('o caminho é preservado — é ele que mede audiência', () => {
    expect(semQueryString({ url: 'https://app.exemplo/tendencia' })).toEqual({
      url: 'https://app.exemplo/tendencia',
    })
  })

  it('preserva os outros campos do evento', () => {
    const enviado = semQueryString({
      url: 'https://app.exemplo/dashboard?mes=2026-09',
      referrer: 'https://exemplo.com',
    })
    expect(enviado).toEqual({
      url: 'https://app.exemplo/dashboard',
      referrer: 'https://exemplo.com',
    })
  })

  it('URL que não faz parse não é enviada de jeito nenhum', () => {
    expect(semQueryString({ url: 'isto não é uma url' })).toBe(null)
  })
})

/**
 * O consentimento: é ele que decide se o script existe.
 *
 * A distinção que estes testes trancam é entre **não respondeu** e
 * **recusou**. Tratar os dois como iguais na leitura seria cômodo e erraria
 * na tela de Conta, que precisa dizer qual dos dois é o caso.
 */
describe('consentimento de medição', () => {
  const memoria = new Map<string, string>()

  beforeEach(() => {
    memoria.clear()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => memoria.get(k) ?? null,
        setItem: (k: string, v: string) => void memoria.set(k, v),
        removeItem: (k: string) => void memoria.delete(k),
      },
      dispatchEvent: () => true,
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('sem resposta, NÃO mede — a base legal vem antes do tratamento', () => {
    expect(lerConsentimento()).toBe(null)
    expect(podeMedir(null)).toBe(false)
    expect(PADRAO_ANTES_DE_DECIDIR).toBe('recusado')
  })

  it('aceitar liga, recusar desliga', () => {
    gravarConsentimento('aceito')
    expect(lerConsentimento()).toBe('aceito')
    expect(podeMedir(lerConsentimento())).toBe(true)

    gravarConsentimento('recusado')
    expect(lerConsentimento()).toBe('recusado')
    expect(podeMedir(lerConsentimento())).toBe(false)
  })

  it('esquecer a resposta volta ao estado de não respondido, e não a recusado', () => {
    gravarConsentimento('aceito')
    limparConsentimento()
    // Os dois não medem, mas só um deles faz o banner perguntar de novo.
    expect(lerConsentimento()).toBe(null)
    expect(podeMedir(lerConsentimento())).toBe(false)
  })

  it('valor estragado no armazenamento é tratado como não respondido', () => {
    memoria.set(CHAVE_CONSENTIMENTO, 'talvez')
    expect(lerConsentimento()).toBe(null)
    expect(podeMedir(lerConsentimento())).toBe(false)
  })

  it('armazenamento bloqueado não quebra nada, e não passa a medir', () => {
    // Janela anônima: o acessor em si lança.
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('bloqueado')
      },
      dispatchEvent: () => true,
    })

    expect(lerConsentimento()).toBe(null)
    expect(podeMedir(lerConsentimento())).toBe(false)
    expect(() => gravarConsentimento('aceito')).not.toThrow()
  })

  it('a chave é versionada, para consentimento velho não valer por coleta nova', () => {
    expect(CHAVE_CONSENTIMENTO).toMatch(/-v\d+$/)
  })
})
