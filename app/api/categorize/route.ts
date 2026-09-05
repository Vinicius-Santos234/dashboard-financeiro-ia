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
import { consumirCotaLlm, CotaExcedidaError } from '@/lib/firestore/quota'
import { categorizarTransacoes, TAMANHO_LOTE } from '@/lib/llm/categorize'
import { GeminiProvider } from '@/lib/llm/gemini'
import { mensagemPublicaLlm } from '@/lib/llm/errors'
import { LIMITE_LLM_DIARIO } from '@/lib/domain/limites'

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

    // Cobra a cota ANTES de chamar o Gemini: cobrar depois deixaria o custo
    // acontecer e só então recusar, que é o contrário do que o teto serve.
    // Cada lote de ${TAMANHO_LOTE} transações é uma chamada.
    const lotes = Math.ceil(
      transacoes.filter((t) => !t.aiOptOut && t.amountCents < 0).length / TAMANHO_LOTE
    )
    if (lotes > 0) await consumirCotaLlm(uid, lotes, LIMITE_LLM_DIARIO)
    const categorias = await categorizarTransacoes(transacoes, regras, provider)

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
    if (erro instanceof CotaExcedidaError) {
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
