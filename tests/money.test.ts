import { describe, it, expect } from 'vitest'
import {
  parseAmountToCents,
  formatCents,
  sumCents,
  ValorInvalidoError,
} from '@/lib/domain/money'

describe('parseAmountToCents', () => {
  it('lê o formato BR', () => {
    expect(parseAmountToCents('1.234,56')).toBe(123456)
    expect(parseAmountToCents('-47,90')).toBe(-4790)
    expect(parseAmountToCents('0,05')).toBe(5)
  })

  it('lê o formato US, que é como a maioria dos OFX vem', () => {
    expect(parseAmountToCents('1,234.56')).toBe(123456)
    expect(parseAmountToCents('-47.90')).toBe(-4790)
    expect(parseAmountToCents('1234.5')).toBe(123450)
  })

  it('aceita símbolo de moeda e espaço', () => {
    expect(parseAmountToCents('R$ 1.234,56')).toBe(123456)
    expect(parseAmountToCents(' -R$ 47,90 ')).toBe(-4790)
  })

  it('entende as duas notações de negativo que planilha usa', () => {
    expect(parseAmountToCents('(45,90)')).toBe(-4590)
    expect(parseAmountToCents('45,90-')).toBe(-4590)
  })

  it('trata separador único seguido de 3 dígitos como milhar', () => {
    // A convenção documentada em money.ts. `1.234` é mil duzentos e trinta e
    // quatro, não um e vinte e três.
    expect(parseAmountToCents('1.234')).toBe(123400)
    expect(parseAmountToCents('1,234')).toBe(123400)
    expect(parseAmountToCents('12,345')).toBe(1234500)
    expect(parseAmountToCents('1.234.567')).toBe(123456700)
  })

  it('exige que o milhar esteja agrupado de três em três', () => {
    // Sem esta checagem, `1.2.3,4,5` sairia como 1234,50 caladamente — que é
    // o pior desfecho para dinheiro: lixo entrando e número plausível saindo.
    for (const malformado of ['1.2.3,4,5', '12345,678', '1.23.456', '1,2345.67']) {
      expect(() => parseAmountToCents(malformado)).toThrow(ValorInvalidoError)
    }
  })

  it('trata separador único seguido de 1 ou 2 dígitos como decimal', () => {
    expect(parseAmountToCents('1.23')).toBe(123)
    expect(parseAmountToCents('1,2')).toBe(120)
  })

  it('não usa float em momento nenhum', () => {
    // 0.1 + 0.2 !== 0.3 em float. Em centavos é aritmética de inteiro.
    const soma = sumCents([
      parseAmountToCents('0,10'),
      parseAmountToCents('0,20'),
    ])
    expect(soma).toBe(30)
    expect(soma).toBe(parseAmountToCents('0,30'))
  })

  it('recusa o que não consegue interpretar em vez de chutar', () => {
    for (const ruim of ['', '   ', 'abc', 'R$', '--5', '1,2,3']) {
      expect(() => parseAmountToCents(ruim)).toThrow(ValorInvalidoError)
    }
  })
})

describe('formatCents', () => {
  it('formata em BRL', () => {
    //   é o espaço não-quebrável que o Intl usa depois de R$.
    expect(formatCents(123456).replace(/ /g, ' ')).toBe('R$ 1.234,56')
    expect(formatCents(-4790).replace(/ /g, ' ')).toBe('-R$ 47,90')
    expect(formatCents(0).replace(/ /g, ' ')).toBe('R$ 0,00')
  })

  it('faz a volta completa sem perder centavo', () => {
    for (const original of [1, -1, 5, 99, 100, 123456, -987654321]) {
      const texto = formatCents(original).replace(/[R$\s ]/g, '')
      expect(parseAmountToCents(texto)).toBe(original)
    }
  })
})
