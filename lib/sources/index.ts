import { createHash } from 'node:crypto'
import { ofxAdapter } from './ofx'
import { csvAdapter, type CsvMapping } from './csv'
import type { ParseResult } from './types'

/**
 * Ponto único de entrada para ler um arquivo. Spec §5.1.
 *
 * A escolha do adapter mora aqui, e não na rota, para que a rota não precise
 * saber quais formatos existem — que é a mesma razão de o Open Finance poder
 * entrar depois sem tocar em `/api/imports`.
 */

export type EntradaImport =
  | { source: 'ofx'; bytes: ArrayBuffer }
  | { source: 'csv'; bytes: ArrayBuffer; mapping: CsvMapping }

export async function lerArquivo(entrada: EntradaImport): Promise<ParseResult> {
  if (entrada.source === 'ofx') {
    return ofxAdapter.parse(entrada.bytes, undefined)
  }
  return csvAdapter.parse(entrada.bytes, entrada.mapping)
}

/** Deduz o formato pela extensão. A tela pode sobrepor. */
export function formatoPeloNome(filename: string): 'ofx' | 'csv' | null {
  const n = filename.toLowerCase()
  if (n.endsWith('.ofx') || n.endsWith('.qfx')) return 'ofx'
  if (n.endsWith('.csv') || n.endsWith('.txt')) return 'csv'
  return null
}

/**
 * sha256 do arquivo. Não impede reimportar — quem impede linha duplicada é o
 * fingerprint. Serve só para a tela poder avisar "você já importou este
 * arquivo em tal data", que é informação útil e não um bloqueio.
 */
export function hashDoArquivo(bytes: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

export { ofxAdapter, csvAdapter }
export type { CsvMapping }
