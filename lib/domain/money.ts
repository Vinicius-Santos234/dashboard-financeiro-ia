/**
 * Dinheiro em centavos, sempre. Spec §3 D9.
 *
 * `float` erra centavo (0.1 + 0.2 !== 0.3) e o erro só aparece lá na frente,
 * quando a soma das fatias do gráfico não bate com o total do extrato — que é
 * exatamente o critério de aceite da E5.
 */

/** Erro de valor que o parser não conseguiu interpretar com segurança. */
export class ValorInvalidoError extends Error {
  constructor(readonly entrada: string) {
    super(`Valor não reconhecido: ${JSON.stringify(entrada)}`)
    this.name = 'ValorInvalidoError'
  }
}

/**
 * Converte o valor como o banco escreveu para centavos.
 *
 * O problema real: o mesmo extrato pode vir em formato BR (`1.234,56`) ou US
 * (`1,234.56`), e às vezes com sinal depois do número (`45,90-`) ou entre
 * parênteses (`(45,90)`), que é como planilha representa negativo.
 *
 * A regra de desempate, quando só existe um separador:
 *   - seguido de exatamente 3 dígitos e nada mais → separador de milhar
 *   - qualquer outro caso → separador decimal
 *
 * Ou seja: `1.234` vira 1234,00 e `1.23` vira 1,23. É convenção, não
 * adivinhação perfeita — um extrato que escreva `1.234` querendo dizer R$ 1,23
 * seria lido errado. Nunca vi um que faça isso, e o mapeamento de colunas do
 * CSV mostra o valor interpretado antes de importar, então o usuário vê.
 */
export function parseAmountToCents(entrada: string): number {
  if (typeof entrada !== 'string') throw new ValorInvalidoError(String(entrada))

  let s = entrada.trim()
  if (s === '') throw new ValorInvalidoError(entrada)

  // (45,90) — negativo em notação de planilha
  let negativo = false
  if (/^\(.*\)$/.test(s)) {
    negativo = true
    s = s.slice(1, -1).trim()
  }

  // Sinal no fim: "45,90-"
  if (s.endsWith('-')) {
    negativo = true
    s = s.slice(0, -1).trim()
  }

  // Símbolo de moeda, espaços internos e non-breaking space
  s = s.replace(/R\$|BRL/gi, '').replace(/[\s ]/g, '')

  if (s.startsWith('-')) {
    negativo = true
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }

  if (!/^[\d.,]+$/.test(s)) throw new ValorInvalidoError(entrada)

  const temPonto = s.includes('.')
  const temVirgula = s.includes(',')

  let decimalSep: '.' | ',' | null = null
  let milharSep: '.' | ',' | null = null

  if (temPonto && temVirgula) {
    // Os dois presentes: o ÚLTIMO a aparecer é o decimal, o outro é milhar.
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) {
      decimalSep = '.'
      milharSep = ','
    } else {
      decimalSep = ','
      milharSep = '.'
    }
  } else if (temPonto || temVirgula) {
    const sep = temPonto ? '.' : ','
    const ocorrencias = s.split(sep).length - 1
    const depois = s.length - s.lastIndexOf(sep) - 1
    // Mais de um separador só faz sentido como milhar (1.234.567), e um
    // separador seguido de exatamente 3 dígitos também (12,345).
    if (ocorrencias > 1 || depois === 3) milharSep = sep
    else decimalSep = sep
  }

  let inteiro: string
  let fracao: string

  if (decimalSep === null) {
    inteiro = s
    fracao = '00'
  } else {
    const corte = s.lastIndexOf(decimalSep)
    inteiro = s.slice(0, corte)
    fracao = s.slice(corte + 1)
    if (!/^\d{1,2}$/.test(fracao)) throw new ValorInvalidoError(entrada)
    fracao = fracao.padEnd(2, '0')
  }

  if (inteiro === '') inteiro = '0'

  // A parte inteira precisa estar bem formada — ou dígitos puros, ou milhares
  // agrupados de três em três. Sem esta checagem, `1.2.3,4,5` vira 1234,50
  // caladamente, que é o pior desfecho possível para um valor em dinheiro:
  // entrada malformada saindo como número plausível.
  const inteiroValido = milharSep
    ? new RegExp(`^\\d{1,3}(?:\\${milharSep}\\d{3})+$`).test(inteiro)
    : /^\d+$/.test(inteiro)

  if (!inteiroValido) throw new ValorInvalidoError(entrada)

  inteiro = inteiro.replace(/[.,]/g, '')

  const centavos = Number(inteiro) * 100 + Number(fracao)
  if (!Number.isSafeInteger(centavos)) throw new ValorInvalidoError(entrada)

  return negativo ? -centavos : centavos
}

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
})

/** Centavos → `R$ 1.234,56`. */
export function formatCents(centavos: number): string {
  return BRL.format(centavos / 100)
}

/** Soma sem passar por float em momento nenhum. */
export function sumCents(valores: readonly number[]): number {
  return valores.reduce((acc, v) => acc + v, 0)
}
