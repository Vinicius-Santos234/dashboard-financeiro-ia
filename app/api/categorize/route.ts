import { NextResponse } from 'next/server'
import { z } from 'zod'
import { exigirSessaoGravavel } from '@/lib/firebase/session'
import { ContaDemoError } from '@/lib/domain/demo'
import {
  aplicarCategorias,
  atualizarImport,
  incrementarHitsRegras,
  listarRegras,
  listarTransacoesDoImport,
  listarTransacoesDoMes,
  obterImport,
  revalidarPendentes,
} from '@/lib/firestore/repo'
import {
  consumirCotaLlm,
  CotaExcedidaError,
  CotaGlobalExcedidaError,
} from '@/lib/firestore/quota'
import { categorizarTransacoes, planejarCategorizacao, TAMANHO_LOTE, MAX_LOTES } from '@/lib/llm/categorize'
import { mesValido } from '@/lib/domain/month'
import { GeminiProvider } from '@/lib/llm/gemini'
import { mensagemPublicaLlm } from '@/lib/llm/errors'
import { LIMITE_LLM_DIARIO, LIMITE_LLM_GLOBAL_DIARIO } from '@/lib/domain/limites'

const entradaSchema = z.object({
  importId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
  month: z.string().refine(mesValido).optional(),
  confirmarEnvio: z.literal(true),
}).refine((v) => Boolean(v.importId) !== Boolean(v.month))

export const maxDuration = 60

export async function POST(request: Request) {
  let uid: string
  try {
    ;({ uid } = await exigirSessaoGravavel('A categorização por IA'))
  } catch (erro) {
    if (erro instanceof ContaDemoError) {
      return NextResponse.json({ erro: erro.message }, { status: 403 })
    }
    return NextResponse.json({ erro: 'Sem sessão.' }, { status: 401 })
  }

  const entrada = entradaSchema.safeParse(await request.json().catch(() => null))
  if (!entrada.success) {
    return NextResponse.json({ erro: 'Escolha um mês ou uma importação e confirme o envio à IA.' }, { status: 400 })
  }

  try {
    const { importId, month } = entrada.data
    if (importId && !(await obterImport(uid, importId))) {
      return NextResponse.json({ erro: 'Importação não encontrada.' }, { status: 404 })
    }
    // O mês recupera também pendências de imports antigos e reimportações
    // deduplicadas, sem alterar a origem dos documentos.
    const todas = importId
      ? await listarTransacoesDoImport(uid, importId)
      : await listarTransacoesDoMes(uid, month!)
    const pendentes = todas.filter((t) => t.category === null && !t.aiOptOut)
    const transacoes = pendentes.slice(0, TAMANHO_LOTE * MAX_LOTES)
    if (transacoes.length === 0) {
      return NextResponse.json({ total: 0, porIa: 0, porRegra: 0, optOut: 0, restantes: 0 })
    }
    const provider = new GeminiProvider()
    const regras = await listarRegras(uid)

    // O plano decide o que vai à IA sem chamar nada, então a cota é cobrada
    // pelo número REAL de chamadas. Antes a conta era estimada sobre toda
    // saída sem opt-out, e as regras só entravam depois: 1.000 transações que
    // casassem com regras gastavam 20 unidades e faziam zero chamadas.
    const plano = planejarCategorizacao(transacoes, regras)

    // Cobrada ANTES de chamar: cobrar depois deixaria o custo acontecer e só
    // então recusar, que é o contrário do que o teto serve.
    if (plano.lotes > 0) {
      await consumirCotaLlm(
        uid,
        plano.lotes,
        LIMITE_LLM_DIARIO,
        LIMITE_LLM_GLOBAL_DIARIO
      )
    }

    const categorias = await categorizarTransacoes(
      plano, provider, (lote) => revalidarPendentes(uid, lote)
    )

    const idsAplicados = new Set(await aplicarCategorias(uid, categorias))
    const aplicadas = categorias.filter((c) => idsAplicados.has(c.fingerprint))
    await incrementarHitsRegras(
      uid,
      aplicadas.flatMap((resultado) =>
        resultado.rulePattern ? [resultado.rulePattern] : []
      )
    )
    const importIds = new Set(transacoes.flatMap((t) => t.importId ? [t.importId] : []))
    // Um import pode atravessar meses: só fica concluído quando não tem pendências.
    for (const id of importIds) {
      const linhas = await listarTransacoesDoImport(uid, id)
      const registro = await obterImport(uid, id)
      if (registro && registro.status !== 'failed') {
        await atualizarImport(uid, id, {
          status: linhas.some((t) => t.category === null && !t.aiOptOut) ? 'parsed' : 'categorized',
        })
      }
    }

    return NextResponse.json({
      total: aplicadas.length,
      porIa: aplicadas.filter((c) => c.categorySource === 'ai').length,
      porRegra: aplicadas.filter((c) => c.categorySource === 'rule').length,
      optOut: aplicadas.filter((c) => c.categorySource === 'user').length,
      preservadas: transacoes.length - aplicadas.length,
      restantes: pendentes.length - transacoes.length,
      model: provider.model,
    })
  } catch (erro) {
    if (erro instanceof CotaExcedidaError || erro instanceof CotaGlobalExcedidaError) {
      return NextResponse.json({ erro: erro.message }, { status: 429 })
    }

    // Só a mensagem, não o objeto de erro inteiro: a resposta crua do provedor
    // pode carregar trechos do payload enviado para os logs.
    console.error(
      'Falha ao categorizar transações com o Gemini:',
      erro instanceof Error ? erro.message : 'erro desconhecido'
    )
    return NextResponse.json(
      {
        erro:
          'Não foi possível concluir a categorização. Tente novamente nas pendências: ' +
          mensagemPublicaLlm(erro),
      },
      { status: 502 }
    )
  }
}
