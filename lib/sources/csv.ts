import Papa from 'papaparse'
import { parseAmountToCents } from '@/lib/domain/money'
import { detectDateFormat, parseCsvDate, type FormatoData } from './date'
import type {
  LinhaDescartada,
  ParseResult,
  RawTransaction,
  SourceAdapter,
} from './types'

/**
 * CSV é o formato que cobre o banco que não exporta OFX e a fatura de cartão.
 *
 * Não existe "CSV de extrato": cada banco escolhe o separador, a ordem das
 * colunas, o nome delas e se o valor negativo vem com sinal ou numa segunda
 * coluna. Por isso o adapter recebe um mapeamento em vez de adivinhar — e
 * `inspecionar()` existe para a tela conseguir sugerir esse mapeamento.
 */

export class CsvInvalidoError extends Error {
  constructor(motivo: string) {
    super(`Arquivo CSV inválido: ${motivo}`)
    this.name = 'CsvInvalidoError'
  }
}

export interface CsvMapping {
  colunaData: string
  colunaDescricao: string
  /** Coluna de valor. Com sinal, quando o banco usa uma coluna só. */
  colunaValor: string
  /**
   * Quando o banco usa duas colunas (entrada e saída), esta é a de saída e
   * `colunaValor` passa a ser a de entrada. Os dois vêm positivos e o sinal
   * sai da coluna em que o número está.
   */
  colunaValorSaida?: string
  formatoData?: FormatoData
}

export interface InspecaoCsv {
  colunas: string[]
  amostra: Record<string, string>[]
  totalLinhas: number
  sugestao: Partial<CsvMapping>
  /** `false` quando dd/mm e mm/dd empataram: a tela precisa perguntar. */
  formatoDataCerto: boolean
}

function semBom(texto: string): string {
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto
}

function texto(input: ArrayBuffer | string): string {
  if (typeof input === 'string') return semBom(input)
  // CSV de banco brasileiro também aparece em windows-1252. Se o UTF-8 der
  // caractere de substituição, é sinal de que não era UTF-8.
  const bytes = new Uint8Array(input)
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  if (!utf8.includes('�')) return semBom(utf8)
  return semBom(new TextDecoder('windows-1252').decode(bytes))
}

function normalizar(cabecalho: string): string {
  return cabecalho
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

const PISTAS_DATA = ['data', 'date', 'dia', 'competencia', 'lancamento']
const PISTAS_DESCRICAO = [
  'descricao',
  'description',
  'historico',
  'memo',
  'title',
  'titulo',
  'estabelecimento',
  'detalhe',
]
const PISTAS_VALOR = ['credito', 'entrada', 'valor', 'amount', 'quantia', 'montante', 'value']
const PISTAS_SAIDA = ['debito', 'saida', 'debit', 'despesa', 'pagamento']

function acharColuna(colunas: string[], pistas: string[]): string | undefined {
  for (const pista of pistas) {
    const achou = colunas.find((c) => normalizar(c).includes(pista))
    if (achou) return achou
  }
  return undefined
}

/** Lê o arquivo só para a tela de mapeamento — não importa nada. */
export function inspecionar(input: ArrayBuffer | string): InspecaoCsv {
  const { data, meta, errors } = Papa.parse<Record<string, string>>(texto(input), {
    header: true,
    skipEmptyLines: 'greedy',
  })

  const colunas = (meta.fields ?? []).filter((c) => c.trim() !== '')
  if (colunas.length === 0) {
    throw new CsvInvalidoError(
      errors[0]?.message ?? 'não foi possível identificar a linha de cabeçalho'
    )
  }

  const colunaData = acharColuna(colunas, PISTAS_DATA)
  const colunaSaida = acharColuna(colunas, PISTAS_SAIDA)

  const deteccao = colunaData
    ? detectDateFormat(data.map((l) => l[colunaData] ?? ''))
    : { formato: 'dd/mm/yyyy' as FormatoData, certeza: false }

  return {
    colunas,
    amostra: data.slice(0, 5),
    totalLinhas: data.length,
    sugestao: {
      colunaData,
      colunaDescricao: acharColuna(colunas, PISTAS_DESCRICAO),
      colunaValor: acharColuna(colunas, PISTAS_VALOR),
      colunaValorSaida: colunaSaida,
      // Só sugere formato quando a detecção TEM certeza. Sugerir mesmo sem
      // certeza fazia a tela copiar o palpite para o mapeamento, e a recusa de
      // ambiguidade no `parse` nunca rodava — a correção existia e a interface
      // a contornava.
      formatoData: deteccao.certeza ? deteccao.formato : undefined,
    },
    formatoDataCerto: deteccao.certeza,
  }
}

export const csvAdapter: SourceAdapter<CsvMapping> = {
  id: 'csv',

  async parse(input, mapping): Promise<ParseResult> {
    const { data, meta, errors } = Papa.parse<Record<string, string>>(
      texto(input),
      { header: true, skipEmptyLines: 'greedy' }
    )

    const colunas = meta.fields ?? []
    for (const obrigatoria of [
      mapping.colunaData,
      mapping.colunaDescricao,
      mapping.colunaValor,
    ]) {
      if (!colunas.includes(obrigatoria)) {
        throw new CsvInvalidoError(`o arquivo não tem a coluna "${obrigatoria}"`)
      }
    }

    // A mesma coluna nos dois papéis daria `abs(v) - abs(v) = 0` em toda
    // linha, e o extrato inteiro viraria zero — depois classificado como
    // `receita`, porque zero não é negativo.
    if (
      mapping.colunaValorSaida &&
      mapping.colunaValorSaida === mapping.colunaValor
    ) {
      throw new CsvInvalidoError(
        'a coluna de saídas precisa ser diferente da de valores; do jeito que ' +
          'está, toda linha viraria zero'
      )
    }

    // Aspa não fechada não corrompe uma linha: ela engole as seguintes dentro
    // do mesmo campo. Ou seja, o arquivo inteiro passa a não ter mais como ser
    // dividido em linhas com segurança, e um relatório por linha mentiria.
    // Por isso este caso recusa o arquivo em vez de virar `descartadas`.
    const fatal = errors.find(
      (e) => e.code === 'MissingQuotes' || e.code === 'UndetectableDelimiter'
    )
    if (fatal) {
      throw new CsvInvalidoError(
        fatal.code === 'MissingQuotes'
          ? `há uma aspa não fechada por volta da linha ${(fatal.row ?? 0) + 2}, ` +
            'e a partir dela não dá para saber onde cada linha termina'
          : 'não foi possível identificar o separador de colunas'
      )
    }

    const formato = (() => {
      if (mapping.formatoData) return mapping.formatoData

      const deteccao = detectDateFormat(
        data.map((l) => l[mapping.colunaData] ?? '')
      )

      // `certeza: false` significa que todo dia e todo mês do arquivo são ≤ 12
      // e nada desempata. Assumir dd/mm aqui trocaria dia por mês em silêncio:
      // 04/05 entraria como 4 de maio num arquivo americano onde é 5 de abril.
      // A detecção já sabia que não sabia; faltava alguém escutar.
      if (!deteccao.certeza) {
        throw new CsvInvalidoError(
          'não dá para deduzir o formato das datas: todos os valores têm dia e ' +
            'mês menores que 13. Informe `formatoData` no mapeamento.'
        )
      }

      return deteccao.formato
    })()

    const transactions: RawTransaction[] = []
    const descartadas: LinhaDescartada[] = []

    // Erros por linha que não impedem delimitar o arquivo (campo a mais, campo
    // a menos) entram em `descartadas` como qualquer outra perda — nunca somem.
    const errosPorLinha = new Map<number, string>()
    for (const e of errors) {
      if (e.row === undefined) continue
      errosPorLinha.set(e.row, e.message)
    }

    data.forEach((linha, i) => {
      // +2: uma pela linha de cabeçalho, uma porque humano conta do 1.
      const numero = i + 2
      const bruta = Object.values(linha).join(' | ').slice(0, 120)

      const erroDaLinha = errosPorLinha.get(i)
      if (erroDaLinha) {
        descartadas.push({
          linha: numero,
          conteudo: bruta,
          motivo: `CSV malformado: ${erroDaLinha}`,
        })
        return
      }

      const dataBruta = (linha[mapping.colunaData] ?? '').trim()
      const valorBruto = (linha[mapping.colunaValor] ?? '').trim()
      const saidaBruta = mapping.colunaValorSaida
        ? (linha[mapping.colunaValorSaida] ?? '').trim()
        : ''

      if (dataBruta === '' || (valorBruto === '' && saidaBruta === '')) {
        descartadas.push({
          linha: numero,
          conteudo: bruta,
          motivo: dataBruta === '' ? 'sem data' : 'sem valor',
        })
        return
      }

      try {
        const occurredOn = parseCsvDate(dataBruta, formato)

        let amountCents: number
        if (mapping.colunaValorSaida) {
          const entrada = valorBruto === '' ? 0 : Math.abs(parseAmountToCents(valorBruto))
          const saida = saidaBruta === '' ? 0 : Math.abs(parseAmountToCents(saidaBruta))
          amountCents = entrada - saida
        } else {
          amountCents = parseAmountToCents(valorBruto)
        }

        const description =
          (linha[mapping.colunaDescricao] ?? '').trim() || 'SEM DESCRIÇÃO'

        transactions.push({ occurredOn, amountCents, description })
      } catch (erro) {
        descartadas.push({
          linha: numero,
          conteudo: bruta,
          motivo: erro instanceof Error ? erro.message : 'linha ilegível',
        })
      }
    })

    const datas = transactions.map((t) => t.occurredOn).sort()

    return {
      transactions,
      periodStart: datas[0],
      periodEnd: datas[datas.length - 1],
      descartadas,
    }
  },
}
