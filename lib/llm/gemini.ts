import 'server-only'
import { GoogleGenAI, Type } from '@google/genai'
import { CATEGORIAS, CATEGORIA_CRITERIO } from '@/lib/domain/categories'
import { insightBodySchema } from './schema'
import { MAX_TOKENS_SAIDA } from '@/lib/domain/limites'
import type { EntradaCategoriaLlm, EntradaInsightLlm, LLMProvider } from './provider'

const MODELO_PADRAO = 'gemini-3.6-flash'

function cliente(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada.')
  return new GoogleGenAI({ apiKey })
}

function jsonDaResposta(texto: string | undefined): unknown {
  if (!texto) throw new Error('O Gemini respondeu sem conteúdo.')
  try {
    return JSON.parse(texto)
  } catch {
    throw new Error('O Gemini respondeu fora do formato JSON esperado.')
  }
}

export class GeminiProvider implements LLMProvider {
  readonly model = process.env.GEMINI_MODEL || MODELO_PADRAO

  async categorizar(entrada: readonly EntradaCategoriaLlm[]): Promise<unknown> {
    const criterios = CATEGORIAS.map(
      (categoria) => `- ${categoria}: ${CATEGORIA_CRITERIO[categoria]}`
    ).join('\n')

    const resposta = await cliente().models.generateContent({
      model: this.model,
      contents:
        'Classifique cada transação financeira brasileira em exatamente uma categoria. ' +
        'Use receita para valores positivos, salvo evidência clara de estorno. ' +
        'Não invente contexto para PIX ou transferências genéricas: use outros.\n\n' +
        `${criterios}\n\nTransações:\n${JSON.stringify(entrada)}`,
      config: {
        maxOutputTokens: MAX_TOKENS_SAIDA,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              category: { type: Type.STRING, enum: [...CATEGORIAS] },
              confidence: { type: Type.NUMBER },
            },
            required: ['id', 'category', 'confidence'],
          },
        },
      },
    })

    return jsonDaResposta(resposta.text)
  }

  async gerarInsight(entrada: EntradaInsightLlm) {
    const resposta = await cliente().models.generateContent({
      model: this.model,
      contents:
        'Escreva um resumo curto, objetivo e não moralista sobre os gastos do mês. ' +
        'Compare somente os agregados fornecidos. Valores estão em centavos. ' +
        'Não dê aconselhamento financeiro, não invente causas e não mencione categorias zeradas.\n\n' +
        JSON.stringify(entrada),
      config: {
        maxOutputTokens: MAX_TOKENS_SAIDA,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            headline: { type: Type.STRING },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING },
                  severity: { type: Type.STRING, enum: ['info', 'atencao'] },
                  category: {
                    type: Type.STRING,
                    enum: [...CATEGORIAS],
                    nullable: true,
                  },
                },
                required: ['text', 'severity', 'category'],
              },
            },
          },
          required: ['headline', 'items'],
        },
      },
    })

    return insightBodySchema.parse(jsonDaResposta(resposta.text))
  }
}
