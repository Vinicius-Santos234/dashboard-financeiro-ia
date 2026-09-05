import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ofxAdapter, OfxInvalidoError } from '@/lib/sources/ofx'
import { csvAdapter, inspecionar, CsvInvalidoError } from '@/lib/sources/csv'
import { parseOfxDate, parseCsvDate, detectDateFormat, DataInvalidaError } from '@/lib/sources/date'

function fixture(nome: string): ArrayBuffer {
  const buf = readFileSync(resolve(__dirname, 'fixtures/derivadas', nome))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe('parseOfxDate', () => {
  it('fica com o dia que o banco registrou, sem converter fuso', () => {
    // Converter para UTC moveria a compra da meia-noite de 14/08 para 13/08.
    // O extrato diz 14; o app precisa dizer 14.
    expect(parseOfxDate('20260814')).toBe('2026-08-14')
    expect(parseOfxDate('20260814120000[-3:BRT]')).toBe('2026-08-14')
    expect(parseOfxDate('20260814000000[-3:BRT]')).toBe('2026-08-14')
  })

  it('recusa data impossível em vez de deixar o Date normalizar', () => {
    // new Date(2026, 1, 30) vira 2 de março calado. Aqui não.
    for (const ruim of ['20260230', '20261301', '2026', 'ontem', '']) {
      expect(() => parseOfxDate(ruim)).toThrow(DataInvalidaError)
    }
  })
})

describe('detectDateFormat', () => {
  it('uma linha com dia > 12 decide o arquivo inteiro', () => {
    expect(detectDateFormat(['03/04/2026', '25/04/2026'])).toEqual({
      formato: 'dd/mm/yyyy',
      certeza: true,
    })
    expect(detectDateFormat(['04/03/2026', '04/25/2026'])).toEqual({
      formato: 'mm/dd/yyyy',
      certeza: true,
    })
  })

  it('reconhece ISO pelo ano na frente', () => {
    expect(detectDateFormat(['2026-08-14'])).toEqual({
      formato: 'yyyy-mm-dd',
      certeza: true,
    })
  })

  it('admite que não sabe quando nada desempata', () => {
    // 03/04 é 3 de abril ou 4 de março, e não há como saber. A tela precisa
    // perguntar em vez de o parser fingir que decidiu.
    const r = detectDateFormat(['03/04/2026', '05/06/2026'])
    expect(r.certeza).toBe(false)
    expect(r.formato).toBe('dd/mm/yyyy')
  })
})

describe('parseCsvDate', () => {
  it('lê os três formatos', () => {
    expect(parseCsvDate('14/08/2026', 'dd/mm/yyyy')).toBe('2026-08-14')
    expect(parseCsvDate('08/14/2026', 'mm/dd/yyyy')).toBe('2026-08-14')
    expect(parseCsvDate('2026-08-14', 'yyyy-mm-dd')).toBe('2026-08-14')
    expect(parseCsvDate('14.08.26', 'dd/mm/yyyy')).toBe('2026-08-14')
  })
})

describe('ofxAdapter — SGML com tags que não fecham', () => {
  it('lê as transações e ignora o que não dá para ler', async () => {
    const r = await ofxAdapter.parse(fixture('conta-corrente.ofx'), undefined)

    expect(r.transactions).toHaveLength(5)
    expect(r.descartadas).toHaveLength(1)
    expect(r.descartadas[0].motivo).toBe('sem DTPOSTED')

    const salario = r.transactions[0]
    expect(salario.occurredOn).toBe('2026-08-05')
    expect(salario.amountCents).toBe(320000)
    expect(salario.description).toBe('SALARIO EMPRESA XYZ LTDA')
    expect(salario.fitid).toBe('68a1f0c2004')

    const ifood = r.transactions[1]
    expect(ifood.amountCents).toBe(-4790)
    expect(ifood.description).toBe('IFD*IFOOD SAO PAULO')
  })

  it('descarta linha sem derrubar o import inteiro', async () => {
    // Uma linha ilegível não pode custar as outras cinco — mas também não pode
    // sumir calada, senão o total diverge do extrato sem pista de onde.
    const r = await ofxAdapter.parse(fixture('conta-corrente.ofx'), undefined)
    expect(r.descartadas[0].conteudo).toContain('LINHA SEM DATA POSTADA')
  })

  it('lê a conta e o período', async () => {
    const r = await ofxAdapter.parse(fixture('conta-corrente.ofx'), undefined)
    expect(r.account).toMatchObject({
      id: '12345678-9',
      kind: 'checking',
      currency: 'BRL',
      institution: 'BANCO DE TESTE S.A.',
    })
    expect(r.periodStart).toBe('2026-08-01')
    expect(r.periodEnd).toBe('2026-08-31')
  })
})

describe('ofxAdapter — windows-1252', () => {
  it('decodifica pelo charset do header, não chutando UTF-8', async () => {
    // Este é o teste que justifica o decodificador existir. Lido como UTF-8,
    // o mesmo arquivo entrega "PADARIA S<?>O JO<?>O" — e é isso que iria para
    // a LLM categorizar.
    const r = await ofxAdapter.parse(fixture('cartao.ofx'), undefined)
    const descricoes = r.transactions.map((t) => t.description)

    expect(descricoes).toContain('PADARIA SÃO JOÃO')
    expect(descricoes).toContain('FARMÁCIA CENTRAL')
    expect(descricoes.join(' ')).not.toContain('�')
  })

  it('reconhece cartão de crédito e valor em vírgula decimal', async () => {
    const r = await ofxAdapter.parse(fixture('cartao.ofx'), undefined)
    expect(r.account?.kind).toBe('credit_card')
    expect(r.transactions[0].amountCents).toBe(-3250)
    expect(r.transactions[1].amountCents).toBe(-12990)
  })

  it('junta MEMO e NAME quando os dois trazem coisas diferentes', async () => {
    const r = await ofxAdapter.parse(fixture('cartao.ofx'), undefined)
    expect(r.transactions[2].description).toBe('ASSINATURA SERVIÇO DE STREAMING')
  })

  it('recusa arquivo que não é OFX', async () => {
    await expect(ofxAdapter.parse('isto aqui é um txt qualquer', undefined)).rejects.toThrow(
      OfxInvalidoError
    )
  })
})

describe('csvAdapter — duas colunas de valor', () => {
  const mapping = {
    colunaData: 'Data',
    colunaDescricao: 'Histórico',
    colunaValor: 'Crédito',
    colunaValorSaida: 'Débito',
    formatoData: 'dd/mm/yyyy' as const,
  }

  it('tira o sinal da coluna em que o número está', async () => {
    const r = await csvAdapter.parse(fixture('duas-colunas.csv'), mapping)

    expect(r.transactions[0]).toMatchObject({
      occurredOn: '2026-08-01',
      amountCents: 320000,
      description: 'SALARIO EMPRESA XYZ LTDA',
    })
    expect(r.transactions[1].amountCents).toBe(-4790)
    expect(r.transactions[4].amountCents).toBe(-150000)
  })

  it('separa o que não conseguiu ler, com o número da linha do arquivo', async () => {
    const r = await csvAdapter.parse(fixture('duas-colunas.csv'), mapping)
    expect(r.transactions).toHaveLength(5)
    expect(r.descartadas).toHaveLength(2)
    // Linha 7 do arquivo: a que não tem data. O número precisa bater com o
    // que a pessoa vê ao abrir o CSV, senão a mensagem não ajuda ninguém.
    expect(r.descartadas.map((d) => d.linha)).toEqual([7, 8])
    expect(r.descartadas[0].motivo).toBe('sem data')
    expect(r.descartadas[1].motivo).toMatch(/Valor não reconhecido/)
  })

  it('recusa mapeamento que aponta para coluna inexistente', async () => {
    await expect(
      csvAdapter.parse(fixture('duas-colunas.csv'), {
        ...mapping,
        colunaValor: 'Coluna Que Nao Existe',
      })
    ).rejects.toThrow(CsvInvalidoError)
  })
})

describe('csvAdapter — coluna única com sinal', () => {
  it('lê separador vírgula, ISO e valor negativo', async () => {
    const r = await csvAdapter.parse(fixture('coluna-unica.csv'), {
      colunaData: 'date',
      colunaDescricao: 'title',
      colunaValor: 'amount',
    })

    expect(r.transactions).toHaveLength(4)
    expect(r.transactions[0].amountCents).toBe(320000)
    expect(r.transactions[1].amountCents).toBe(-4790)
    expect(r.periodStart).toBe('2026-08-05')
    expect(r.periodEnd).toBe('2026-08-15')
  })
})

describe('inspecionar — o que alimenta a tela de mapeamento', () => {
  it('sugere as colunas e detecta o formato de data', () => {
    const r = inspecionar(fixture('duas-colunas.csv'))

    expect(r.colunas).toEqual(['Data', 'Histórico', 'Débito', 'Crédito'])
    // 7 linhas de dados no arquivo. `inspecionar` conta o bruto de propósito:
    // a tela mostra "7 linhas encontradas" antes de qualquer filtro, e é o
    // `parse` que depois separa as 5 aproveitáveis das 2 descartadas.
    expect(r.totalLinhas).toBe(7)
    expect(r.sugestao.colunaData).toBe('Data')
    expect(r.sugestao.colunaDescricao).toBe('Histórico')
    expect(r.sugestao.colunaValorSaida).toBe('Débito')
    // 25/08 no arquivo prova que o primeiro campo é o dia.
    expect(r.formatoDataCerto).toBe(true)
    expect(r.sugestao.formatoData).toBe('dd/mm/yyyy')
  })

  it('recusa arquivo sem cabeçalho reconhecível', () => {
    expect(() => inspecionar('')).toThrow(CsvInvalidoError)
  })
})

describe('csvAdapter — os achados do Codex', () => {
  const base = {
    colunaData: 'Data',
    colunaDescricao: 'Historico',
    colunaValor: 'Valor',
  }

  it('3.1 — recusa o arquivo quando uma aspa não fechada engole linhas', async () => {
    // Aspa aberta e não fechada não estraga uma linha: ela absorve as
    // seguintes dentro do mesmo campo. A partir dali não dá para saber onde
    // cada linha termina, então relatar "descartadas" por linha seria mentira.
    // A versão anterior descartava o array `errors` do Papa Parse inteiro e
    // importava os dados parciais em silêncio.
    await expect(
      csvAdapter.parse(fixture('aspa-quebrada.csv'), base)
    ).rejects.toThrow(CsvInvalidoError)

    await expect(
      csvAdapter.parse(fixture('aspa-quebrada.csv'), base)
    ).rejects.toThrow(/aspa não fechada/)
  })

  it('3.2 — recusa data ambígua em vez de chutar dd/mm', async () => {
    // Todos os dias e meses do arquivo são ≤ 12, então nada desempata.
    // `detectDateFormat` já devolvia `certeza: false`; faltava alguém escutar.
    // Importar como dd/mm trocaria 04/05 (5 de abril, no formato americano)
    // por 4 de maio, sem erro e sem descarte.
    await expect(
      csvAdapter.parse(fixture('data-ambigua.csv'), base)
    ).rejects.toThrow(/não dá para deduzir o formato das datas/)
  })

  it('3.2 — com o formato informado, o mesmo arquivo importa normalmente', async () => {
    const r = await csvAdapter.parse(fixture('data-ambigua.csv'), {
      ...base,
      formatoData: 'mm/dd/yyyy',
    })

    expect(r.transactions).toHaveLength(2)
    expect(r.transactions[0].occurredOn).toBe('2026-04-05')
    expect(r.transactions[1].occurredOn).toBe('2026-06-07')
  })
})
