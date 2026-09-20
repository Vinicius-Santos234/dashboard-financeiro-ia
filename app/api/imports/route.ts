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
import {
  classifyTransactions,
  resolvedFlowType,
  STATEMENT_PROFILES,
  summarizeFlows,
  type StatementProfile,
} from '@/lib/domain/financial-flow'
import { fechamentoSugerido, periodoDaFatura } from '@/lib/domain/invoice'
import { fluxoDaRegra } from '@/lib/domain/rules'
import { anonymize } from '@/lib/privacy/anonymize'
import {
  configurarFatura,
  contaPadrao,
  gravarTransacoes,
  importsComMesmoHash,
  lerPerfil,
  listarContas,
  listarRegras,
  obterConta,
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

const financialProfileSchema = z.enum(STATEMENT_PROFILES)

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
  let financialProfile: StatementProfile | null = null
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
    const profile = financialProfileSchema.safeParse(form.get('financialProfile'))
    if (!profile.success) {
      return NextResponse.json(
        { erro: 'CSV exige escolher o tipo de extrato e a convenção dos valores.' },
        { status: 400 }
      )
    }
    financialProfile = profile.data
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

  financialProfile ??=
    lido.account?.kind === 'credit_card'
      ? 'credit_card_negative_expenses'
      : 'bank_account'

  /**
   * As regras de fluxo entram DEPOIS do classificador e antes de tudo mais.
   * Spec 003 §5 D5.
   *
   * O `flowType` decide como a linha participa dos totais, e isso acontece no
   * import — antes de qualquer chamada à IA. Uma correção que a pessoa fez no
   * mês passado (`PAG*CONDOMINIO` é conta paga, não pagamento de fatura) só
   * vale para os próximos meses se for aplicada aqui.
   *
   * Roda sobre a descrição crua, que é onde a confusão acontece, e antes da
   * prévia: o que a tela conta por tipo tem de ser o que vai ser gravado.
   */
  const regrasDeFluxo = await listarRegras(uid)
  const transactions = classifyTransactions(lido.transactions, financialProfile).map(
    (transacao) => {
      const imposto = fluxoDaRegra(transacao.description, regrasDeFluxo)
      return imposto ? { ...transacao, flowType: imposto } : transacao
    }
  )
  const flowSummary = summarizeFlows(transactions)

  // A prévia percorre exatamente o mesmo parser e a mesma normalização do
  // import real. Nada é persistido; ela existe para a pessoa detectar sinal
  // invertido antes de confirmar.
  if (new URL(request.url).searchParams.get('prever') === '1') {
    /**
     * O fechamento já configurado para cartão, se houver. Spec 003 §8 C8.
     *
     * A prévia precisa dele para poder avisar o que antes acontecia calado:
     * uma fatura atravessa dois meses civis, e **sem dia de fechamento o app
     * agrupa pelo calendário** — então importar a fatura de setembro engorda
     * agosto, e a pessoa não tem como saber por quê.
     */
    const fechamentoDoCartao =
      financialProfile === 'bank_account'
        ? null
        : ((await listarContas(uid)).find(
            (c) => c.kind === 'credit_card' && c.closingDay !== null
          )?.closingDay ??
          // Conta ainda não existe na primeira importação; o que vale é o que
          // a pessoa declarou no perfil, e é ele que a conta vai herdar.
          (await lerPerfil(uid)).fechamentoPadraoCartao)

    return NextResponse.json({
      periodo: { de: lido.periodStart ?? null, ate: lido.periodEnd ?? null },
      lidas: transactions.length,
      descartadas: lido.descartadas,
      financialProfile,
      fechamentoDoCartao,
      flowSummary,
      /**
       * As primeiras linhas **como o app as entendeu**, e não como estão no
       * arquivo. Spec 003 §8 C1.
       *
       * É o que substitui a pergunta abstrata sobre convenção de sinal: em vez
       * de pedir para a pessoa descrever o formato do arquivo dela, o app
       * mostra três lançamentos dela já interpretados — data, descrição e o
       * tipo que cada um recebeu. Reconhecer a própria compra é uma tarefa que
       * qualquer pessoa faz; descrever uma convenção de sinal não é.
       *
       * Sai da MESMA lista que vai ser gravada, por isso prova o caminho
       * inteiro e não uma simulação dele.
       */
      amostra: transactions.slice(0, 3).map((t) => ({
        occurredOn: t.occurredOn,
        description: t.description,
        amountCents: t.amountCents,
        flowType: resolvedFlowType(t),
      })),
    })
  }

  // --- persistência --------------------------------------------------------
  const fileHash = hashDoArquivo(bytes)
  const anteriores = await importsComMesmoHash(uid, fileHash)

  const kindDaConta =
    lido.account?.kind ??
    (financialProfile === 'bank_account' ? 'checking' : 'credit_card')

  // Sem id de conta no arquivo, o nome precisa dizer de que extrato ele veio.
  // `Conta principal` para os dois era metade do defeito da C6: o nome é o que
  // a pessoa lê na tela, e "minha fatura está dentro da conta principal" é uma
  // frase que não descreve nada que ela reconheça.
  const accountId = await contaPadrao(uid, {
    name: lido.account?.id
      ? `${lido.account.institution ?? 'Conta'} ${lido.account.id}`
      : kindDaConta === 'credit_card'
        ? 'Cartão principal'
        : 'Conta principal',
    institution: lido.account?.institution ?? null,
    kind: kindDaConta,
  })

  /**
   * O fechamento da fatura. Spec 003 §8 C8.
   *
   * Vem de `lido.closingDate`, que **só** o OFX de cartão com `<DTEND>`
   * declarado preenche — nunca de `periodEnd`.
   *
   * A distinção custou um defeito: `periodEnd` é a última data observada, e
   * num CSV isso é a última compra. Uma fatura Nubank que fecha dia 13 com
   * última compra dia 3 configurava fechamento no dia **3**, e a partir daí
   * cada importação reparticionava tudo em torno de uma data inventada —
   * inclusive jogando lançamentos num mês que a pessoa nunca importou.
   *
   * A precedência é **pessoa antes de arquivo**, nesta ordem:
   *
   *   1. o que a conta já tem — se existe, alguém decidiu, e decisão não se
   *      sobrescreve;
   *   2. o fechamento que a pessoa declarou no perfil antes de ter cartão
   *      cadastrado. Declaração explícita ganha de dedução;
   *   3. o `DTEND` do arquivo, que é um palpite bom mas ainda é palpite.
   *
   * Em qualquer caso a tela de Conta mostra o valor e de onde ele veio, para
   * a pessoa poder corrigir.
   */
  const conta = await obterConta(uid, accountId)
  let closingDay = conta?.closingDay ?? null

  // `closingDayFonte` diferente de `null` significa que alguém já decidiu —
  // inclusive quem decidiu **apagar** e agrupar pelo mês civil. Só conta que
  // nunca foi configurada aceita preenchimento automático.
  const jaDecidido = conta?.closingDayFonte != null

  if (kindDaConta === 'credit_card' && closingDay === null && !jaDecidido) {
    const perfil = await lerPerfil(uid)
    const daPessoa = perfil.fechamentoPadraoCartao
    const doArquivo = fechamentoSugerido(lido.closingDate)
    const escolhido = daPessoa ?? doArquivo

    if (escolhido !== null) {
      await configurarFatura(uid, accountId, {
        closingDay: escolhido,
        dueDay: conta?.dueDay ?? perfil.vencimentoPadraoCartao ?? null,
        fonte: daPessoa !== null ? 'pessoa' : 'arquivo',
      })
      closingDay = escolhido
    }
  }

  const comFingerprint = atribuirFingerprints(accountId, transactions)

  const importId = await registrarImport(uid, {
    accountId,
    source,
    financialProfile,
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
        accountKind: kindDaConta,
        closingDay,
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
      /**
       * Os períodos em que as transações **foram realmente gravadas**.
       *
       * Não dá para deduzir isso da data da primeira compra: com fechamento
       * configurado, uma compra de 28/09 vai para a fatura de outubro. O link
       * "Revisar e categorizar" usava `periodo.de.slice(0, 7)` e mandava a
       * pessoa para setembro, onde não havia nada do que ela acabara de
       * importar — deixando os pendentes sem revisão.
       */
      periodosGravados: [
        ...new Set(
          comFingerprint.map((t) => periodoDaFatura(t.occurredOn, closingDay))
        ),
      ].sort(),
      lidas: lido.transactions.length,
      importadas: gravadas,
      duplicadas: jaExistiam,
      descartadas: lido.descartadas,
      jaImportadoAntes: anteriores.length > 0,
      financialProfile,
      flowSummary,
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
