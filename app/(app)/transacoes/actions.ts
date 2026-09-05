'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { CATEGORIAS } from '@/lib/domain/categories'
import { normalizarPadrao } from '@/lib/domain/rules'
import { exigirSessao } from '@/lib/firebase/session'
import {
  definirAiOptOut,
  obterTransacao,
  recategorizar,
  salvarRegra,
} from '@/lib/firestore/repo'

const correcaoSchema = z.object({
  fingerprint: z.string().min(1),
  category: z.enum(CATEGORIAS),
  pattern: z.string().max(120).optional(),
})

export async function corrigirCategoria(formData: FormData): Promise<void> {
  const entrada = correcaoSchema.parse({
    fingerprint: formData.get('fingerprint'),
    category: formData.get('category'),
    pattern: formData.get('pattern') || undefined,
  })
  const { uid } = await exigirSessao()
  const transacao = await obterTransacao(uid, entrada.fingerprint)
  if (!transacao) throw new Error('Transação não encontrada.')
  if (transacao.amountCents >= 0 && entrada.category !== 'receita') {
    throw new Error('Entradas precisam permanecer na categoria Receita.')
  }

  const padrao = entrada.pattern ? normalizarPadrao(entrada.pattern) : ''
  if (padrao && padrao.length < 3) {
    throw new Error('O padrão da regra precisa ter ao menos 3 caracteres.')
  }

  await recategorizar(uid, entrada.fingerprint, entrada.category, 'user')
  if (padrao) await salvarRegra(uid, padrao, entrada.category)

  revalidatePath('/transacoes')
  revalidatePath('/dashboard')
}

const optOutSchema = z.object({
  fingerprint: z.string().min(1),
  optOut: z.enum(['true', 'false']),
})

export async function alterarOptOut(formData: FormData): Promise<void> {
  const entrada = optOutSchema.parse({
    fingerprint: formData.get('fingerprint'),
    optOut: formData.get('optOut'),
  })
  const { uid } = await exigirSessao()
  await definirAiOptOut(uid, entrada.fingerprint, entrada.optOut === 'true')
  revalidatePath('/transacoes')
  revalidatePath('/dashboard')
}
