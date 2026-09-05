import { NextResponse } from 'next/server'
import { z } from 'zod'
import { exigirSessao } from '@/lib/firebase/session'
import { lerInsight, lerRollup, salvarInsight } from '@/lib/firestore/repo'
import { mesAnterior, mesValido } from '@/lib/domain/month'
import { GeminiProvider } from '@/lib/llm/gemini'
import { obterOuGerarInsight } from '@/lib/llm/insights'
import { mensagemPublicaLlm } from '@/lib/llm/errors'

const entradaSchema = z.object({
  month: z.string().refine(mesValido, 'Mês inválido.'),
  regenerate: z.boolean().optional().default(false),
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
    return NextResponse.json({ erro: 'Informe um mês válido.' }, { status: 400 })
  }

  const { month, regenerate } = entrada.data
  const provider = new GeminiProvider()

  try {
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
    console.error('Falha ao gerar insight com o Gemini.', erro)
    return NextResponse.json({ erro: mensagemPublicaLlm(erro) }, { status: 502 })
  }
}
