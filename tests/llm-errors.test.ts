import { describe, expect, it } from 'vitest'
import { mensagemPublicaLlm } from '@/lib/llm/errors'

describe('mensagemPublicaLlm', () => {
  it('traduz falta de cota sem expor a resposta bruta do provedor', () => {
    const mensagem = mensagemPublicaLlm(
      new Error('{"status":"RESOURCE_EXHAUSTED","message":"prepayment credits are depleted"}')
    )

    expect(mensagem).toContain('cota ou os créditos')
    expect(mensagem).not.toContain('RESOURCE_EXHAUSTED')
  })

  it('traduz modelo indisponível', () => {
    expect(mensagemPublicaLlm(new Error('model is not available: NOT_FOUND'))).toContain(
      'GEMINI_MODEL'
    )
  })

  it('não expõe erros inesperados', () => {
    expect(mensagemPublicaLlm(new Error('segredo interno'))).not.toContain('segredo interno')
  })
})
