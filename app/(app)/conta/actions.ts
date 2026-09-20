'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { adminAuth } from '@/lib/firebase/admin'
import { MAIOR_DIA_DE_FECHAMENTO } from '@/lib/domain/invoice'
import { parseAmountToCents, ValorInvalidoError } from '@/lib/domain/money'
import { encerrarSessao, exigirSessaoGravavel } from '@/lib/firebase/session'
import {
  apagarTudoDoUsuario,
  configurarFatura,
  definirFechamentoPadrao,
  definirRendaMensal,
} from '@/lib/firestore/repo'

/**
 * A renda mensal, em centavos. Spec 003 §5 D4 e §8 C3.
 *
 * Campo vazio **apaga** a renda, e apagar volta ao estado de não informada —
 * sem percentual nenhum na tela. Zero é recusado de propósito: um denominador
 * zerado e um ausente levam a leituras opostas, e gravar zero mostraria
 * `Infinity%` ou um `0%` que não quer dizer nada.
 */
export async function salvarRenda(formData: FormData): Promise<void> {
  const bruto = String(formData.get('renda') ?? '').trim()
  const { uid } = await exigirSessaoGravavel('Informar a renda')

  if (bruto === '') {
    await definirRendaMensal(uid, null)
    revalidatePath('/conta')
    revalidatePath('/dashboard')
    return
  }

  let centavos: number
  try {
    centavos = parseAmountToCents(bruto)
  } catch (erro) {
    if (erro instanceof ValorInvalidoError) {
      throw new Error('Valor não reconhecido. Use algo como 4.500,00.')
    }
    throw erro
  }

  if (centavos <= 0) {
    throw new Error('A renda precisa ser maior que zero. Deixe vazio para não informar.')
  }

  await definirRendaMensal(uid, centavos)
  revalidatePath('/conta')
  revalidatePath('/dashboard')
}

/** `''` apaga; fora de 1–28 é recusado. Spec 003 §8 C8. */
function diaDoCiclo(valor: string): number | null {
  const limpo = valor.trim()
  if (limpo === '') return null
  const n = Number(limpo)
  if (!Number.isInteger(n) || n < 1 || n > MAIOR_DIA_DE_FECHAMENTO) {
    throw new Error(`Use um dia entre 1 e ${MAIOR_DIA_DE_FECHAMENTO}.`)
  }
  return n
}

const cicloSchema = z.object({
  closingDay: z.string(),
  dueDay: z.string(),
})

/**
 * O fechamento declarado **antes de existir cartão cadastrado**.
 * Spec 003 §8 C8.
 *
 * Sem isto, a ordem obrigatória era importar torto, descobrir, configurar e
 * migrar — porque a conta de cartão só nasce na primeira importação, e é
 * justamente ela que precisa saber o dia do fechamento. Aqui a pessoa diz
 * antes, e a primeira importação já agrupa certo.
 */
export async function salvarFaturaPadrao(formData: FormData): Promise<void> {
  const entrada = cicloSchema.parse({
    closingDay: formData.get('closingDay') ?? '',
    dueDay: formData.get('dueDay') ?? '',
  })
  const { uid } = await exigirSessaoGravavel('Configurar a fatura')

  await definirFechamentoPadrao(
    uid,
    diaDoCiclo(entrada.closingDay),
    diaDoCiclo(entrada.dueDay)
  )

  revalidatePath('/conta')
}

const faturaSchema = z.object({
  accountId: z.string().min(1).max(300),
  closingDay: z.string(),
  dueDay: z.string(),
})

/**
 * Configura fechamento e vencimento de um cartão. Spec 003 §8 C8.
 *
 * Isto muda o período das **próximas** importações. O histórico só se move com
 * `npm run migrar:faturas`, que faz backup antes e confere o recálculo depois
 * — mudar a chave de dado já gravado a partir de um campo de formulário é o
 * risco que a spec manda evitar (§10).
 */
export async function salvarFatura(formData: FormData): Promise<void> {
  const entrada = faturaSchema.parse({
    accountId: formData.get('accountId'),
    closingDay: formData.get('closingDay') ?? '',
    dueDay: formData.get('dueDay') ?? '',
  })
  const { uid } = await exigirSessaoGravavel('Configurar a fatura')

  await configurarFatura(uid, entrada.accountId, {
    closingDay: diaDoCiclo(entrada.closingDay),
    dueDay: diaDoCiclo(entrada.dueDay),
    fonte: 'pessoa',
  })

  revalidatePath('/conta')
}

const confirmacaoSchema = z.object({
  confirmacao: z.literal('EXCLUIR'),
})

export async function excluirConta(formData: FormData): Promise<void> {
  confirmacaoSchema.parse({ confirmacao: formData.get('confirmacao') })
  // Recusa a conta demo: o recursiveDelete e irreversivel, e um visitante
  // apagaria a demonstracao para todo mundo que viesse depois.
  const { uid } = await exigirSessaoGravavel('A exclusão de conta')

  // Primeiro os dados: se o Auth falhar, a pessoa ainda consegue entrar e
  // repetir. Fazer ao contrário poderia deixar dados órfãos sem uma conta que
  // conseguisse solicitar a limpeza novamente.
  await apagarTudoDoUsuario(uid)
  await adminAuth().deleteUser(uid)
  await encerrarSessao()
  redirect('/login?conta=excluida')
}

