'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { adminAuth } from '@/lib/firebase/admin'
import { encerrarSessao, exigirSessao } from '@/lib/firebase/session'
import { apagarTudoDoUsuario } from '@/lib/firestore/repo'

const confirmacaoSchema = z.object({
  confirmacao: z.literal('EXCLUIR'),
})

export async function excluirConta(formData: FormData): Promise<void> {
  confirmacaoSchema.parse({ confirmacao: formData.get('confirmacao') })
  const { uid } = await exigirSessao()

  // Primeiro os dados: se o Auth falhar, a pessoa ainda consegue entrar e
  // repetir. Fazer ao contrário poderia deixar dados órfãos sem uma conta que
  // conseguisse solicitar a limpeza novamente.
  await apagarTudoDoUsuario(uid)
  await adminAuth().deleteUser(uid)
  await encerrarSessao()
  redirect('/login?conta=excluida')
}

