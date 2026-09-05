import { NextResponse } from 'next/server'
import { z } from 'zod'
import { exigirSessao } from '@/lib/firebase/session'
import {
  aplicarCategorias,
  atualizarImport,
  incrementarHitsRegras,
  listarRegras,
  listarTransacoesDoImport,
} from '@/lib/firestore/repo'
import { categorizarTransacoes } from '@/lib/llm/categorize'
import { GeminiProvider } from '@/lib/llm/gemini'
import { mensagemPublicaLlm } from '@/lib/llm/errors'

const entradaSchema = z.object({
  importId: z.string().min(1).max(200),
})

export const maxDuration = 60

export async function POST(request: Request) {
  let uid: string
  try {
    ;({ uid } = await exigirSessao())
  } catch {
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
    console.error('Falha ao categorizar transações com o Gemini.', erro)
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
