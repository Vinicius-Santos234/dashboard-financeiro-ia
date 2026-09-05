/**
 * Datas — onde OFX e CSV divergem, e onde dá para errar o dia inteiro.
 */

export class DataInvalidaError extends Error {
  constructor(readonly entrada: string) {
    super(`Data não reconhecida: ${JSON.stringify(entrada)}`)
    this.name = 'DataInvalidaError'
  }
}

function ehDataReal(ano: number, mes: number, dia: number): boolean {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return false
  if (ano < 1900 || ano > 2200) return false
  const d = new Date(Date.UTC(ano, mes - 1, dia))
  return (
    d.getUTCFullYear() === ano &&
    d.getUTCMonth() === mes - 1 &&
    d.getUTCDate() === dia
  )
}

function iso(ano: number, mes: number, dia: number): string {
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

/**
 * `DTPOSTED` do OFX: `YYYYMMDD`, às vezes `YYYYMMDDHHMMSS`, às vezes com fuso
 * no fim: `20260814120000[-3:BRT]`.
 *
 * Fica só com os 8 primeiros dígitos **de propósito**. Converter para UTC
 * moveria a compra da meia-noite de 14/08 para 13/08 — o extrato do banco diz
 * 14, o app precisa dizer 14. O dia que interessa é o que o banco registrou,
 * não o instante absoluto.
 */
export function parseOfxDate(entrada: string): string {
  const digitos = entrada.trim().replace(/^\[|\]$/g, '')
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(digitos)
  if (!m) throw new DataInvalidaError(entrada)

  const ano = Number(m[1])
  const mes = Number(m[2])
  const dia = Number(m[3])
  if (!ehDataReal(ano, mes, dia)) throw new DataInvalidaError(entrada)

  return iso(ano, mes, dia)
}

export type FormatoData = 'dd/mm/yyyy' | 'mm/dd/yyyy' | 'yyyy-mm-dd'

/**
 * Data de CSV. O separador pode ser `/`, `-` ou `.`, e o ano pode vir com 2
 * dígitos — que é resolvido pela janela 2000–2099, já que extrato bancário
 * anterior a isso não vai aparecer aqui.
 */
export function parseCsvDate(entrada: string, formato: FormatoData): string {
  const partes = entrada.trim().split(/[/\-.]/)
  if (partes.length !== 3 || partes.some((p) => !/^\d+$/.test(p))) {
    throw new DataInvalidaError(entrada)
  }

  let ano: number
  let mes: number
  let dia: number

  if (formato === 'yyyy-mm-dd') {
    ;[ano, mes, dia] = partes.map(Number)
  } else if (formato === 'dd/mm/yyyy') {
    ;[dia, mes, ano] = partes.map(Number)
  } else {
    ;[mes, dia, ano] = partes.map(Number)
  }

  if (ano < 100) ano += 2000
  if (!ehDataReal(ano, mes, dia)) throw new DataInvalidaError(entrada)

  return iso(ano, mes, dia)
}

export type DeteccaoFormato = {
  formato: FormatoData
  /**
   * `false` quando nenhuma linha desempatou entre dd/mm e mm/dd — ou seja,
   * todo dia e todo mês do arquivo são ≤ 12. Aí o formato é um palpite (BR) e
   * a tela de mapeamento precisa perguntar em vez de assumir.
   */
  certeza: boolean
}

/**
 * Descobre o formato olhando o arquivo inteiro, não a primeira linha.
 *
 * `03/04/2026` sozinho é 3 de abril ou 4 de março, e não há como saber. Mas
 * basta **uma** linha com `25/04` no arquivo para provar que o primeiro campo
 * é o dia. Por isso a varredura é sobre todos os valores: uma linha decide o
 * arquivo todo.
 */
export function detectDateFormat(valores: readonly string[]): DeteccaoFormato {
  let viuPrimeiroMaiorQue12 = false
  let viuSegundoMaiorQue12 = false

  for (const v of valores) {
    const bruto = v.trim()
    if (bruto === '') continue

    // ISO é inconfundível: começa com 4 dígitos.
    if (/^\d{4}[/\-.]/.test(bruto)) return { formato: 'yyyy-mm-dd', certeza: true }

    const partes = bruto.split(/[/\-.]/)
    if (partes.length !== 3) continue

    const a = Number(partes[0])
    const b = Number(partes[1])
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue

    if (a > 12) viuPrimeiroMaiorQue12 = true
    if (b > 12) viuSegundoMaiorQue12 = true
  }

  // Os dois > 12 é arquivo inconsistente. Fica em BR e marca sem certeza.
  if (viuPrimeiroMaiorQue12 && !viuSegundoMaiorQue12) {
    return { formato: 'dd/mm/yyyy', certeza: true }
  }
  if (viuSegundoMaiorQue12 && !viuPrimeiroMaiorQue12) {
    return { formato: 'mm/dd/yyyy', certeza: true }
  }

  return { formato: 'dd/mm/yyyy', certeza: false }
}
