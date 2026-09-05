'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { adminAuth } from '@/lib/firebase/admin'
import { encerrarSessao, exigirSessaoGravavel } from '@/lib/firebase/session'
import { apagarTudoDoUsuario } from '@/lib/firestore/repo'

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

