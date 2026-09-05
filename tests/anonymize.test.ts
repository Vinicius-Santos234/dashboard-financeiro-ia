import { describe, expect, it } from 'vitest'
import { anonymize } from '@/lib/privacy/anonymize'

const IDENTIDADE_DO_DONO = ['VINICIUS DA SILVA', 'VINICIUS.SILVA@EXEMPLO.COM']

const FIXTURES = [
  'PAGAMENTO CPF 123.456.789-09 MERCADO CENTRAL',
  'COMPRA CNPJ 12.345.678/0001-90 PADARIA SAO JOAO',
  'TED VINICIUS DA SILVA AG 1234 C/C 98765-4',
  'PIX ENVIADO VINICIUS DA SILVA 11987654321',
  'CONTATO VINICIUS.SILVA@EXEMPLO.COM',
  'PIX RECEBIDO 550e8400-e29b-41d4-a716-446655440000',
  'DOC FAVORECIDO QUALQUER 123456789',
]

describe('anonymize', () => {
  it('nenhum payload de saída contém identificador', () => {
    for (const linha of FIXTURES) {
      const out = anonymize(linha)
      expect(out).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/)
      expect(out).not.toMatch(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/)
      expect(out).not.toMatch(/\d{6,}/)
      expect(out).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
      expect(out).not.toMatch(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)
      for (const identidade of IDENTIDADE_DO_DONO) {
        expect(out).not.toContain(identidade)
      }
    }
  })

  it('trunca a contraparte e mantém só a operação', () => {
    expect(anonymize('PIX ENVIADO MARIA DE SOUZA CPF 123.456.789-09')).toBe(
      'PIX ENVIADO'
    )
    expect(anonymize('TRANSFERÊNCIA: JOAO PEREIRA')).toBe('TRANSFERÊNCIA')
    expect(anonymize('TED EMPRESA SENSIVEL LTDA')).toBe('TED')
  })

  it('mantém o estabelecimento necessário à categorização', () => {
    expect(anonymize('IFOOD SAO PAULO 123456789')).toBe('IFOOD SAO PAULO')
    expect(anonymize('FARMACIA CENTRAL')).toBe('FARMACIA CENTRAL')
  })

  it('remove agência, conta, telefone, e-mail e uuid', () => {
    expect(
      anonymize(
        'PAGAMENTO AG 1234 C/C 98765-4 (11) 98765-4321 pessoa@exemplo.com 550e8400-e29b-41d4-a716-446655440000'
      )
    ).toBe('PAGAMENTO')
  })

  it('nunca devolve string vazia', () => {
    expect(anonymize('123456789')).toBe('DADO REMOVIDO')
  })
})

