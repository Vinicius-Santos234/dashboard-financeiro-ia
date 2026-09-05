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
} from '@/lib/firestore/repo'
import {
  consumirCotaLlm,
  CotaExcedidaError,
  CotaGlobalExcedidaError,
} from '@/lib/firestore/quota'
import { categorizarTransacoes, planejarCategorizacao } from '@/lib/llm/categorize'
import { GeminiProvider } from '@/lib/llm/gemini'
import { mensagemPublicaLlm } from '@/lib/llm/errors'
import { LIMITE_LLM_DIARIO, LIMITE_LLM_GLOBAL_DIARIO } from '@/lib/domain/limites'

const entradaSchema = z.object({
  importId: z.string().min(1).max(200),
})

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
    return NextResponse.json({ erro: 'Informe um importId válido.' }, { status: 400 })
  }

  const transacoes = (await listarTransacoesDoImport(uid, entrada.data.importId)).filter(
    (transacao) => transacao.category === null
  )

  if (transacoes.length === 0) {
    await atualizarImport(uid, entrada.data.importId, { status: 'categorized' })
    return NextResponse.json({ total: 0, porIa: 0, porRegra: 0, optOut: 0 })
  }

  try {
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

    const categorias = await categorizarTransacoes(plano, provider)

    await aplicarCategorias(uid, categorias)
    await incrementarHitsRegras(
      uid,
      categorias.flatMap((resultado) =>
        resultado.rulePattern ? [resultado.rulePattern] : []
      )
    )
    await atualizarImport(uid, entrada.data.importId, { status: 'categorized' })

    return NextResponse.json({
      total: categorias.length,
      porIa: categorias.filter((c) => c.categorySource === 'ai').length,
      porRegra: categorias.filter((c) => c.categorySource === 'rule').length,
      optOut: categorias.filter((c) => c.categorySource === 'user').length,
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
          'As transações foram importadas, mas não categorizadas: ' +
          mensagemPublicaLlm(erro),
      },
      { status: 502 }
    )
  }
}
