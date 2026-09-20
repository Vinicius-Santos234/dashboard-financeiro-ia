'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { CATEGORIAS } from '@/lib/domain/categories'
import { normalizarPadrao } from '@/lib/domain/rules'
import { FLOW_TYPES, resolvedFlowType } from '@/lib/domain/financial-flow'
import { exigirSessaoGravavel } from '@/lib/firebase/session'
import {
  corrigirFluxo,
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
  const { uid } = await exigirSessaoGravavel('Corrigir categoria')
  const transacao = await obterTransacao(uid, entrada.fingerprint)
  if (!transacao) throw new Error('Transação não encontrada.')
  const flowType = resolvedFlowType(transacao)
  if (flowType === 'transfer') {
    throw new Error('Pagamentos e transferências não possuem categoria de gasto.')
  }
  if (flowType === 'income' && entrada.category !== 'receita') {
    throw new Error('Entradas precisam permanecer na categoria Receita.')
  }
  if ((flowType === 'expense' || flowType === 'refund') && entrada.category === 'receita') {
    throw new Error('Compras e estornos precisam permanecer em uma categoria de gasto.')
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

const fluxoSchema = z.object({
  fingerprint: z.string().min(1),
  flowType: z.enum(FLOW_TYPES),
  pattern: z.string().max(120).optional(),
})

/**
 * Corrige o fluxo de uma transação, e opcionalmente transforma isso em regra.
 * Spec 003 §5 D5 e §8 C5.
 *
 * Só a pessoa sabe que um `PAG*` é o nome de uma maquininha e não um pagamento
 * de fatura — o classificador acerta a maioria e erra o resto em silêncio.
 * Reusar o mecanismo de regra é o que faz essa informação valer para os
 * próximos meses **sem gastar token**: a regra de fluxo é aplicada no import,
 * antes de qualquer chamada à IA.
 */
export async function corrigirFluxoDaLinha(formData: FormData): Promise<void> {
  const entrada = fluxoSchema.parse({
    fingerprint: formData.get('fingerprint'),
    flowType: formData.get('flowType'),
    pattern: formData.get('pattern') || undefined,
  })
  const { uid } = await exigirSessaoGravavel('Corrigir o tipo do lançamento')

  const transacao = await obterTransacao(uid, entrada.fingerprint)
  if (!transacao) throw new Error('Transação não encontrada.')

  const padrao = entrada.pattern ? normalizarPadrao(entrada.pattern) : ''
  if (padrao && padrao.length < 3) {
    throw new Error('O padrão da regra precisa ter ao menos 3 caracteres.')
  }

  await corrigirFluxo(uid, entrada.fingerprint, entrada.flowType)

  if (padrao) {
    /**
     * A categoria que a regra leva junto — e quando ela leva **nenhuma**.
     *
     * Transferência e entrada têm categoria obrigatória pelo próprio fluxo.
     * Compra e estorno só levam a que a transação já tinha; quando não havia
     * nenhuma, a regra vai com `null` e a categoria fica em aberto.
     *
     * Inventar `outros` aqui seria o defeito: a partir da regra, toda linha
     * que casasse com o padrão entraria em `outros` sem ninguém ter escolhido,
     * e sairia da fila da IA para sempre — por uma correção que era só sobre
     * o tipo do lançamento.
     */
    const eraTransferencia = resolvedFlowType(transacao) === 'transfer'
    const categoria =
      entrada.flowType === 'transfer'
        ? 'outros'
        : entrada.flowType === 'income'
          ? 'receita'
          : transacao.category === 'receita'
            ? null
            : // O `outros` que o import impõe a toda transferência não é
              // escolha de ninguém. Levá-lo para a regra faria todo lançamento
              // futuro que casasse com o padrão nascer em `outros` e sair da
              // fila da IA — pelo mesmo motivo do caso acima.
              eraTransferencia &&
                transacao.category === 'outros' &&
                transacao.categorySource !== 'user'
              ? null
              : transacao.category

    await salvarRegra(uid, padrao, categoria, entrada.flowType)
  }

  revalidatePath('/transacoes')
  revalidatePath('/dashboard')
  revalidatePath('/regras')
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
  const { uid } = await exigirSessaoGravavel('Alterar o envio à IA')
  await definirAiOptOut(uid, entrada.fingerprint, entrada.optOut === 'true')
  revalidatePath('/transacoes')
  revalidatePath('/dashboard')
}
