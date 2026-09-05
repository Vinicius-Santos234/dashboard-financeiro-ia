import { parseAmountToCents } from '@/lib/domain/money'
import { parseOfxDate } from './date'
import type {
  ContaDetectada,
  LinhaDescartada,
  ParseResult,
  RawTransaction,
  SourceAdapter,
} from './types'

/**
 * Parser de OFX escrito à mão, e não uma dependência.
 *
 * OFX 1.x é SGML: as tags folha frequentemente **não fecham**
 * (`<TRNAMT>-47.90` seguido direto de `<FITID>`), o que quebra parser de XML.
 * OFX 2.x é XML de verdade. Os dois convivem no mesmo formato de arquivo, e
 * cada banco brasileiro emite de um jeito.
 *
 * As bibliotecas de OFX no npm ou assumem uma das duas formas ou estão
 * paradas há anos. Um parser tolerante aqui são ~120 linhas, fica coberto por
 * teste, e não vira dívida quando um banco novo aparecer.
 */

export class OfxInvalidoError extends Error {
  constructor(motivo: string) {
    super(`Arquivo OFX inválido: ${motivo}`)
    this.name = 'OfxInvalidoError'
  }
}

/**
 * Extrato brasileiro vem em windows-1252 com muito mais frequência do que em
 * UTF-8, e ler cp1252 como UTF-8 transforma "PADARIA SÃO JOÃO" em
 * "PADARIA S<?>O JO<?>O" — que depois é o que a LLM recebe para categorizar.
 *
 * O header é sempre ASCII, então dá para lê-lo com latin1 (que nunca falha) e
 * só então decodificar o corpo com o charset certo.
 */
function decodificar(input: ArrayBuffer | string): string {
  if (typeof input === 'string') return input

  const bytes = new Uint8Array(input)
  const cabecalho = new TextDecoder('latin1').decode(bytes.subarray(0, 512))

  let charset = 'utf-8'

  const xml = /encoding=["']([\w-]+)["']/i.exec(cabecalho)
  const ofxEncoding = /^\s*ENCODING:\s*(\S+)/im.exec(cabecalho)
  const ofxCharset = /^\s*CHARSET:\s*(\S+)/im.exec(cabecalho)

  if (xml) {
    charset = xml[1].toLowerCase()
  } else if (ofxEncoding) {
    const enc = ofxEncoding[1].toUpperCase()
    if (enc === 'UTF-8') charset = 'utf-8'
    else if (ofxCharset) {
      // CHARSET:1252 e CHARSET:8859-1 são os dois que aparecem na prática.
      const cs = ofxCharset[1].toUpperCase()
      charset = cs === '1252' ? 'windows-1252' : cs === 'NONE' ? 'latin1' : `iso-8859-1`
    } else {
      charset = 'windows-1252'
    }
  }

  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

const ENTIDADES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
}

function limpar(valor: string): string {
  return valor
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m) => ENTIDADES[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Lê uma tag folha aceitando as duas formas: `<TAG>valor</TAG>` (XML) e
 * `<TAG>valor` sem fechar (SGML). O valor termina no próximo `<` ou na quebra
 * de linha, o que vier primeiro.
 */
function tag(bloco: string, nome: string): string | undefined {
  const m = new RegExp(`<${nome}>([^<\\r\\n]*)`, 'i').exec(bloco)
  if (!m) return undefined
  const v = limpar(m[1])
  return v === '' ? undefined : v
}

function bloco(texto: string, nome: string): string | undefined {
  const m = new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`, 'i').exec(texto)
  return m?.[1]
}

function linhaDe(texto: string, indice: number): number {
  let linha = 1
  for (let i = 0; i < indice && i < texto.length; i++) {
    if (texto[i] === '\n') linha++
  }
  return linha
}

function detectarConta(texto: string): ContaDetectada {
  const conta: ContaDetectada = {}

  const cartao = bloco(texto, 'CCACCTFROM')
  const banco = bloco(texto, 'BANKACCTFROM')
  const origem = cartao ?? banco

  if (origem) {
    conta.id = tag(origem, 'ACCTID')
    const tipo = tag(origem, 'ACCTTYPE')?.toUpperCase()
    if (cartao) conta.kind = 'credit_card'
    else if (tipo === 'SAVINGS') conta.kind = 'savings'
    else conta.kind = 'checking'
  }

  conta.institution = tag(texto, 'ORG') ?? tag(texto, 'FID')
  conta.currency = tag(texto, 'CURDEF')?.toUpperCase()

  return conta
}

export const ofxAdapter: SourceAdapter = {
  id: 'ofx',

  async parse(input): Promise<ParseResult> {
    const texto = decodificar(input)

    if (!/<OFX>/i.test(texto)) {
      throw new OfxInvalidoError('não contém o elemento <OFX>')
    }

    const transactions: RawTransaction[] = []
    const descartadas: LinhaDescartada[] = []

    const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi
    let m: RegExpExecArray | null

    while ((m = re.exec(texto)) !== null) {
      const corpo = m[1]
      const linha = linhaDe(texto, m.index)

      const dtposted = tag(corpo, 'DTPOSTED')
      const trnamt = tag(corpo, 'TRNAMT')
      // MEMO é o campo com a descrição legível. NAME costuma trazer o
      // estabelecimento em arquivos que não usam MEMO. Alguns bancos mandam
      // os dois com conteúdos diferentes e complementares.
      const memo = tag(corpo, 'MEMO')
      const name = tag(corpo, 'NAME')

      if (!dtposted || !trnamt) {
        descartadas.push({
          linha,
          conteudo: limpar(corpo).slice(0, 120),
          motivo: !dtposted ? 'sem DTPOSTED' : 'sem TRNAMT',
        })
        continue
      }

      let occurredOn: string
      let amountCents: number
      try {
        occurredOn = parseOfxDate(dtposted)
        amountCents = parseAmountToCents(trnamt)
      } catch (erro) {
        descartadas.push({
          linha,
          conteudo: limpar(corpo).slice(0, 120),
          motivo: erro instanceof Error ? erro.message : 'valor ou data ilegível',
        })
        continue
      }

      const partes = [memo, name].filter(Boolean) as string[]
      const description =
        partes.length === 2 && partes[0] !== partes[1]
          ? `${partes[0]} ${partes[1]}`
          : (partes[0] ?? tag(corpo, 'TRNTYPE') ?? 'SEM DESCRIÇÃO')

      transactions.push({
        occurredOn,
        amountCents,
        description,
        fitid: tag(corpo, 'FITID'),
      })
    }

    const stmt = bloco(texto, 'BANKTRANLIST') ?? texto
    let periodStart: string | undefined
    let periodEnd: string | undefined
    try {
      const s = tag(stmt, 'DTSTART')
      const e = tag(stmt, 'DTEND')
      periodStart = s ? parseOfxDate(s) : undefined
      periodEnd = e ? parseOfxDate(e) : undefined
    } catch {
      // Período é informativo. Data de transação ilegível vira descarte; data
      // de período ilegível não deve derrubar o import inteiro.
    }

    // Quando o cabeçalho não traz o período, as próprias transações dizem.
    if (transactions.length > 0) {
      const datas = transactions.map((t) => t.occurredOn).sort()
      periodStart ??= datas[0]
      periodEnd ??= datas[datas.length - 1]
    }

    return {
      transactions,
      account: detectarConta(texto),
      periodStart,
      periodEnd,
      descartadas,
    }
  },
}
