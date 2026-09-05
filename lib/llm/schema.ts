import { z } from 'zod'
import { CATEGORIAS } from '@/lib/domain/categories'

export const respostaCategoriaSchema = z.object({
  id: z.string().min(1),
  category: z.enum(CATEGORIAS),
  confidence: z.number().min(0).max(1),
})

export type RespostaCategoria = z.infer<typeof respostaCategoriaSchema>

export const insightItemSchema = z.object({
  text: z.string().min(1).max(280),
  severity: z.enum(['info', 'atencao']),
  category: z.enum(CATEGORIAS).nullable(),
})

export const insightBodySchema = z.object({
  headline: z.string().min(1).max(160),
  items: z.array(insightItemSchema).min(1).max(5),
})

export type InsightBody = z.infer<typeof insightBodySchema>

