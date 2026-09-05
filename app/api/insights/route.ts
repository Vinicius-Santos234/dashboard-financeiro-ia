import { NextResponse } from 'next/server'
import { z } from 'zod'
import { exigirSessao } from '@/lib/firebase/session'
import { ContaDemoError } from '@/lib/domain/demo'
import {
  lerInsight,
  lerRollup,
  salvarInsight,
} from '@/lib/firestore/repo'
import { consumirCotaLlm, CotaExcedidaError } from '@/lib/firestore/quota'
import { mesAnterior, mesValido } from '@/lib/domain/month'
import { GeminiProvider } from '@/lib/llm/gemini'
import { obterOuGerarInsight } from '@/lib/llm/insights'
import { mensagemPublicaLlm } from '@/lib/llm/errors'
import { LIMITE_LLM_DIARIO } from '@/lib/domain/limites'

const entradaSchema = z.object({
  month: z.string().refine(mesValido, 'Mês inválido.'),
  regenerate: z.boolean().optional().default(false),
})

export const maxDuration = 60

export async function POST(request: Request) {
  let uid: string
  let demo: boolean
  try {
    const sessao = await exigirSessao()
    uid = sessao.uid
    demo = sessao.demo
  } catch {
    return NextResponse.json({ erro: 'Sem sessão.' }, { status: 401 })
  }

  const entrada = entradaSchema.safeParse(await request.json().catch(() => null))
  if (!entrada.success) {
    return NextResponse.json({ erro: 'Informe um mês válido.' }, { status: 400 })
  }

  const { month, regenerate } = entrada.data

  // A conta demo LÊ o insight que o seed já gerou, mas não gera nem regera:
  // cada geração é uma chamada paga, e `regenerate: true` pula o cache — em
  // laço, esvaziaria os créditos.
  if (demo) {
    const cacheado = await lerInsight(uid, month)
    if (!cacheado) {
      return NextResponse.json(
        { erro: new ContaDemoError('Gerar insights').message },
        { status: 403 }
      )
    }
    return NextResponse.json({
      insight: { body: cacheado.body, model: cacheado.model },
      gerado: false,
    })
  }

  const provider = new GeminiProvider()

  try {
    // Uma geração é uma chamada. Cobrada antes, pelo mesmo motivo do
    // /api/categorize.
    if (regenerate || !(await lerInsight(uid, month))) {
      await consumirCotaLlm(uid, 1, LIMITE_LLM_DIARIO)
    }

    const resultado = await obterOuGerarInsight(month, regenerate, {
      provider,
      lerCache: async () => {
        const doc = await lerInsight(uid, month)
        return doc ? { body: doc.body, model: doc.model } : null
      },
      salvarCache: (body, model) => salvarInsight(uid, month, body, model),
      lerAgregados: async () => {
        const [atual, anterior] = await Promise.all([
          lerRollup(uid, month),
          lerRollup(uid, mesAnterior(month)),
        ])
        return { atual, anterior }
      },
    })

    return NextResponse.json(resultado)
  } catch (erro) {
    if (erro instanceof CotaExcedidaError) {
      return NextResponse.json({ erro: erro.message }, { status: 429 })
    }

    // Só a mensagem: ver o comentário equivalente em /api/categorize.
    console.error(
      'Falha ao gerar insight com o Gemini:',
      erro instanceof Error ? erro.message : 'erro desconhecido'
    )
    return NextResponse.json({ erro: mensagemPublicaLlm(erro) }, { status: 502 })
  }
}
