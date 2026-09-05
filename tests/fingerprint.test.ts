import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  atribuirFingerprints,
  separarDuplicadas,
  normalizeDescription,
} from '@/lib/domain/fingerprint'
import { ofxAdapter } from '@/lib/sources/ofx'
import { csvAdapter } from '@/lib/sources/csv'
import type { RawTransaction } from '@/lib/sources/types'

const CONTA = '11111111-1111-1111-1111-111111111111'

function fixture(nome: string): ArrayBuffer {
  const buf = readFileSync(resolve(__dirname, 'fixtures/derivadas', nome))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function tx(p: Partial<RawTransaction>): RawTransaction {
  return {
    occurredOn: '2026-08-15',
    amountCents: -800,
    description: 'CAFETERIA DA ESQUINA',
    ...p,
  }
}

describe('normalizeDescription', () => {
  it('tira acento, caixa e espaço duplicado', () => {
    expect(normalizeDescription('  Padaria  São   João ')).toBe('PADARIA SAO JOAO')
  })
})

describe('atribuirFingerprints', () => {
  it('usa o FITID quando o banco fornece', () => {
    const [a] = atribuirFingerprints(CONTA, [tx({ fitid: 'ABC123' })])
    expect(a.fingerprint).toBe(`ofx:${CONTA}:ABC123`)
  })

  it('dois cafés idênticos no mesmo dia são DUAS transações', () => {
    // O caso que o dedupe ingênuo come. Sem `seq`, a segunda linha some e o
    // extrato do app fica menor que o do banco.
    const [a, b] = atribuirFingerprints(CONTA, [tx({}), tx({})])
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('é determinístico: o mesmo arquivo dá o mesmo resultado', () => {
    const entrada = [tx({}), tx({}), tx({ amountCents: -1200 })]
    const primeira = atribuirFingerprints(CONTA, entrada).map((t) => t.fingerprint)
    const segunda = atribuirFingerprints(CONTA, entrada).map((t) => t.fingerprint)
    expect(primeira).toEqual(segunda)
  })

  it('ignora acento e caixa da descrição', () => {
    const [a] = atribuirFingerprints(CONTA, [tx({ description: 'Padaria São João' })])
    const [b] = atribuirFingerprints(CONTA, [tx({ description: 'PADARIA SAO JOAO' })])
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('separa por conta: a mesma compra em contas diferentes não colide', () => {
    const [a] = atribuirFingerprints(CONTA, [tx({})])
    const [b] = atribuirFingerprints('22222222-2222-2222-2222-222222222222', [tx({})])
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('cai para o hash quando o banco repete o FITID', () => {
    // FITID deveria ser único, mas há banco que erra. Confiar cegamente faria
    // a segunda linha ser recusada pela constraint como se fosse duplicata.
    const [a, b] = atribuirFingerprints(CONTA, [
      tx({ fitid: 'REPETIDO', description: 'COMPRA A' }),
      tx({ fitid: 'REPETIDO', description: 'COMPRA B' }),
    ])
    expect(a.fingerprint).toMatch(/^h:/)
    expect(b.fingerprint).toMatch(/^h:/)
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })
})

describe('separarDuplicadas', () => {
  it('deixa passar o que ainda não está no banco', () => {
    const lote = atribuirFingerprints(CONTA, [tx({}), tx({ amountCents: -1200 })])
    const r = separarDuplicadas(lote, [])
    expect(r.novas).toHaveLength(2)
    expect(r.duplicadas).toHaveLength(0)
  })

  it('barra o que já existe', () => {
    const lote = atribuirFingerprints(CONTA, [tx({ fitid: 'X1' }), tx({ fitid: 'X2' })])
    const r = separarDuplicadas(lote, [lote[0].fingerprint])
    expect(r.novas.map((t) => t.fitid)).toEqual(['X2'])
    expect(r.duplicadas.map((t) => t.fitid)).toEqual(['X1'])
  })

  it('remove repetido dentro do próprio lote', () => {
    // Sem isto, o insert em lote estoura na constraint e derruba o import
    // inteiro por causa de uma linha.
    const repetida = { ...tx({}), fingerprint: 'h:igual' }
    const r = separarDuplicadas([repetida, { ...repetida }], [])
    expect(r.novas).toHaveLength(1)
    expect(r.duplicadas).toHaveLength(1)
  })
})

describe('o critério de aceite da E2 — reimportar não dobra o gráfico', () => {
  it('OFX: segunda importação do mesmo arquivo traz 0 novas', async () => {
    const primeira = await ofxAdapter.parse(fixture('conta-corrente.ofx'), undefined)
    const loteA = atribuirFingerprints(CONTA, primeira.transactions)
    const rodadaA = separarDuplicadas(loteA, [])

    expect(rodadaA.novas).toHaveLength(5)
    expect(rodadaA.duplicadas).toHaveLength(0)

    // Mesmo arquivo, de novo — como quem reimporta sem lembrar que já importou.
    const segunda = await ofxAdapter.parse(fixture('conta-corrente.ofx'), undefined)
    const loteB = atribuirFingerprints(CONTA, segunda.transactions)
    const rodadaB = separarDuplicadas(
      loteB,
      rodadaA.novas.map((t) => t.fingerprint)
    )

    expect(rodadaB.novas).toHaveLength(0)
    expect(rodadaB.duplicadas).toHaveLength(5)
  })

  it('CSV: os dois cafés idênticos sobrevivem à primeira importação', async () => {
    const r = await csvAdapter.parse(fixture('duas-colunas.csv'), {
      colunaData: 'Data',
      colunaDescricao: 'Histórico',
      colunaValor: 'Crédito',
      colunaValorSaida: 'Débito',
      formatoData: 'dd/mm/yyyy',
    })

    const lote = atribuirFingerprints(CONTA, r.transactions)
    const rodada = separarDuplicadas(lote, [])

    // 5 linhas legíveis, incluindo os DOIS cafés de R$ 8,00 do dia 15.
    expect(rodada.novas).toHaveLength(5)
    const cafes = rodada.novas.filter((t) => t.amountCents === -800)
    expect(cafes).toHaveLength(2)
    expect(cafes[0].fingerprint).not.toBe(cafes[1].fingerprint)
  })

  it('CSV: reimportar o mesmo arquivo traz 0 novas', async () => {
    const mapping = {
      colunaData: 'Data',
      colunaDescricao: 'Histórico',
      colunaValor: 'Crédito',
      colunaValorSaida: 'Débito',
      formatoData: 'dd/mm/yyyy' as const,
    }

    const a = await csvAdapter.parse(fixture('duas-colunas.csv'), mapping)
    const existentes = atribuirFingerprints(CONTA, a.transactions).map((t) => t.fingerprint)

    const b = await csvAdapter.parse(fixture('duas-colunas.csv'), mapping)
    const rodada = separarDuplicadas(atribuirFingerprints(CONTA, b.transactions), existentes)

    expect(rodada.novas).toHaveLength(0)
    expect(rodada.duplicadas).toHaveLength(5)
  })
})
