'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { CATEGORIAS } from '@/lib/domain/categories'
import { categoriaCabeNoFluxo } from '@/lib/domain/rules'
import { exigirSessaoGravavel } from '@/lib/firebase/session'
import {
  apagarRegra,
  atualizarCategoriaDaRegra,
  listarRegras,
} from '@/lib/firestore/repo'

const idSchema = z.object({ id: z.string().min(1).max(300) })

/**
 * Apaga uma regra. Spec 003 §8 C4.
 *
 * O que ela já categorizou **não** é revertido: aquilo virou dado no momento
 * em que foi gravado. O que muda é o futuro — a regra deixa de ser reaplicada
 * no próximo import, que é exatamente o defeito que a C4 existe para fechar.
 */
export async function removerRegra(formData: FormData): Promise<void> {
  const { id } = idSchema.parse({ id: formData.get('id') })
  const { uid } = await exigirSessaoGravavel('Apagar uma regra')

  await apagarRegra(uid, id)

  revalidatePath('/regras')
  revalidatePath('/transacoes')
}

const edicaoSchema = z.object({
  id: z.string().min(1).max(300),
  category: z.enum(CATEGORIAS),
})

export async function editarRegra(formData: FormData): Promise<void> {
  const entrada = edicaoSchema.parse({
    id: formData.get('id'),
    category: formData.get('category'),
  })
  const { uid } = await exigirSessaoGravavel('Editar uma regra')

  // A mesma restrição que `corrigirCategoria` aplica na linha. Sem ela, editar
  // uma regra de mercado para `receita` tirava a compra da pizza sem tirar do
  // total — as fatias somavam menos que o card.
  const regra = (await listarRegras(uid)).find((r) => r.id === entrada.id)
  if (!regra) throw new Error('Regra não encontrada.')
  if (!categoriaCabeNoFluxo(entrada.category, regra.flowType)) {
    throw new Error(
      entrada.category === 'receita'
        ? 'Receita é categoria de entrada. Uma regra de compra ou estorno não pode usá-la.'
        : 'Uma regra de entrada precisa permanecer na categoria Receita.'
    )
  }

  await atualizarCategoriaDaRegra(uid, entrada.id, entrada.category)

  revalidatePath('/regras')
  revalidatePath('/transacoes')
}
