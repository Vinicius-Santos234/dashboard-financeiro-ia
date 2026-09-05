import { NextResponse } from 'next/server'
import { z } from 'zod'
import { exigirSessao } from '@/lib/firebase/session'
import { ContaDemoError } from '@/lib/domain/demo'
import {
  lerArquivo,
  formatoPeloNome,
  hashDoArquivo,
  type EntradaImport,
} from '@/lib/sources'
import { OfxInvalidoError } from '@/lib/sources/ofx'
import { CsvInvalidoError, inspecionar } from '@/lib/sources/csv'
import { DataInvalidaError } from '@/lib/sources/date'
import { ValorInvalidoError } from '@/lib/domain/money'
import { atribuirFingerprints } from '@/lib/domain/fingerprint'
import { anonymize } from '@/lib/privacy/anonymize'
import {
  contaPadrao,
  gravarTransacoes,
  importsComMesmoHash,
  registrarImport,
  atualizarImport,
} from '@/lib/firestore/repo'

export const maxDuration = 60

/**
 * Import de extrato. Spec §5.2.
 *
 * O arquivo **nunca é gravado** em disco nem em bucket: é parseado em memória
 * e descartado ao fim do request. Só as linhas persistem (§7.4, LGPD).
 *
 * `descriptionClean` é anonimizada antes da persistência e será anonimizada
 * novamente na fronteira da LLM. O texto original fica somente no servidor.
 */

/** Teto de §6.3: acima disso o import é recusado com mensagem clara. */
const MAX_TRANSACOES = 1000

/** 10 MB. Extrato de um ano não passa de alguns KB; isto é só contra abuso. */
const MAX_BYTES = 10 * 1024 * 1024

const mappingSchema = z.object({
  colunaData: z.string().min(1),
  colunaDescricao: z.string().min(1),
  colunaValor: z.string().min(1),
  colunaValorSaida: z.string().optional(),
  formatoData: z.enum(['dd/mm/yyyy', 'mm/dd/yyyy', 'yyyy-mm-dd']).optional(),
})

function erroDeLeitura(erro: unknown): string | null {
  if (
    erro instanceof OfxInvalidoError ||
    erro instanceof CsvInvalidoError ||
    erro instanceof DataInvalidaError ||
    erro instanceof ValorInvalidoError
  ) {
    return erro.message
  }
  return null
}

/**
 * `POST /api/imports?inspecionar=1` — só lê o cabeçalho e devolve a sugestão
 * de mapeamento, sem gravar nada. É o que alimenta a tela de mapeamento de CSV.
 */
export async function POST(request: Request) {
  // A inspeção não grava nada, então a conta demo pode usá-la e ver como a
  // tela de mapeamento funciona. O import de verdade é recusado mais abaixo,
  // depois de sabermos se é inspeção ou gravação.
  let uid: string
  let demo: boolean
  try {
    const sessao = await exigirSessao()
    uid = sessao.uid
    demo = sessao.demo
  } catch {
    return NextResponse.json({ erro: 'Sem sessão.' }, { status: 401 })
  }

  const form = await request.formData()
  const arquivo = form.get('arquivo')

  if (!(arquivo instanceof File)) {
    return NextResponse.json(
      { erro: 'Envie um arquivo no campo `arquivo`.' },
      { status: 400 }
    )
  }

  if (arquivo.size === 0) {
    return NextResponse.json({ erro: 'O arquivo está vazio.' }, { status: 400 })
  }

  if (arquivo.size > MAX_BYTES) {
    return NextResponse.json(
      { erro: 'Arquivo maior que 10 MB.' },
      { status: 413 }
    )
  }

  const source =
    (form.get('source') as 'ofx' | 'csv' | null) ?? formatoPeloNome(arquivo.name)

  if (source !== 'ofx' && source !== 'csv') {
    return NextResponse.json(
      { erro: 'Formato não reconhecido. Envie um .ofx ou um .csv.' },
      { status: 400 }
    )
  }

  const bytes = await arquivo.arrayBuffer()

  // Modo inspeção: a tela de mapeamento precisa das colunas antes de importar.
  if (new URL(request.url).searchParams.get('inspecionar') === '1') {
    if (source !== 'csv') {
      return NextResponse.json(
        { erro: 'Só CSV precisa de mapeamento.' },
        { status: 400 }
      )
    }
    try {
      return NextResponse.json({ inspecao: inspecionar(bytes) })
    } catch (erro) {
      const msg = erroDeLeitura(erro)
      if (msg) return NextResponse.json({ erro: msg }, { status: 422 })
      throw erro
    }
  }

  if (demo) {
    return NextResponse.json(
      { erro: new ContaDemoError('A importação de extratos').message },
      { status: 403 }
    )
  }

  let entrada: EntradaImport
  if (source === 'csv') {
    const bruto = form.get('mapping')
    const parsed = mappingSchema.safeParse(
      typeof bruto === 'string' ? JSON.parse(bruto) : null
    )
    if (!parsed.success) {
      return NextResponse.json(
        { erro: 'CSV exige o mapeamento de colunas.' },
        { status: 400 }
      )
    }
    entrada = { source: 'csv', bytes, mapping: parsed.data }
  } else {
    entrada = { source: 'ofx', bytes }
  }

  // --- leitura -------------------------------------------------------------
  let lido
  try {
    lido = await lerArquivo(entrada)
  } catch (erro) {
    const msg = erroDeLeitura(erro)
    if (msg) return NextResponse.json({ erro: msg }, { status: 422 })
    throw erro
  }

  if (lido.transactions.length === 0) {
    return NextResponse.json(
      {
        erro: 'Nenhuma transação legível no arquivo.',
        descartadas: lido.descartadas,
      },
      { status: 422 }
    )
  }

  if (lido.transactions.length > MAX_TRANSACOES) {
    // §6.3: recusa explícita em vez de queimar cota em silêncio na E4.
    return NextResponse.json(
      {
        erro:
          `O arquivo tem ${lido.transactions.length} transações e o limite é ` +
          `${MAX_TRANSACOES}. Importe um período menor.`,
      },
      { status: 413 }
    )
  }

  if (lido.account?.currency && lido.account.currency !== 'BRL') {
    // Multi-moeda está fora de escopo (§2). Recusar é melhor que somar reais
    // com dólares e mostrar um total que não significa nada.
    return NextResponse.json(
      { erro: `Extrato em ${lido.account.currency}. Só BRL por enquanto.` },
      { status: 422 }
    )
  }

  // --- persistência --------------------------------------------------------
  const fileHash = hashDoArquivo(bytes)
  const anteriores = await importsComMesmoHash(uid, fileHash)

  const accountId = await contaPadrao(uid, {
    name: lido.account?.id
      ? `${lido.account.institution ?? 'Conta'} ${lido.account.id}`
      : 'Conta principal',
    institution: lido.account?.institution ?? null,
    kind: lido.account?.kind ?? 'checking',
  })

  const comFingerprint = atribuirFingerprints(accountId, lido.transactions)

  const importId = await registrarImport(uid, {
    accountId,
    source,
    filename: arquivo.name,
    fileHash,
    periodStart: lido.periodStart ?? null,
    periodEnd: lido.periodEnd ?? null,
    rowsTotal: lido.transactions.length + lido.descartadas.length,
    rowsImported: 0,
    rowsDuplicated: 0,
    rowsDiscarded: lido.descartadas.length,
    status: 'parsed',
    error: null,
  })

  try {
    const { gravadas, jaExistiam } = await gravarTransacoes(
      uid,
      comFingerprint,
      {
        accountId,
        importId,
        source,
        descriptionClean: (t) => anonymize(t.description),
      }
    )

    await atualizarImport(uid, importId, {
      rowsImported: gravadas,
      rowsDuplicated: jaExistiam,
    })

    return NextResponse.json({
      importId,
      accountId,
      periodo: { de: lido.periodStart, ate: lido.periodEnd },
      lidas: lido.transactions.length,
      importadas: gravadas,
      duplicadas: jaExistiam,
      descartadas: lido.descartadas,
      jaImportadoAntes: anteriores.length > 0,
    })
  } catch (erro) {
    // O registro do import fica com o erro em vez de sumir: um import que
    // falhou no meio precisa aparecer no histórico, senão a pessoa vê o total
    // errado e não tem onde procurar o motivo.
    await atualizarImport(uid, importId, {
      status: 'failed',
      error: erro instanceof Error ? erro.message : 'erro desconhecido',
    })
    throw erro
  }
}
