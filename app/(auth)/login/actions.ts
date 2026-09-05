'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { criarSessao, encerrarSessao, lerSessao } from '@/lib/firebase/session'
import { garantirUsuario } from '@/lib/firestore/repo'

export type EstadoAuth = { erro?: string }

const entrada = z.object({
  idToken: z.string().min(1),
  proximo: z.string().optional(),
})

/**
 * Só aceita caminho relativo do próprio app.
 *
 * Sem isto, `?proximo=https://site-falso` transforma a tela de login num
 * redirecionador aberto: o link parece do app, a pessoa faz login e é jogada
 * para fora. `//host` também é absoluto (protocol-relative) e por isso entra
 * na checagem.
 */
function destinoSeguro(proximo: string | undefined): string {
  if (!proximo) return '/dashboard'
  if (!proximo.startsWith('/') || proximo.startsWith('//')) return '/dashboard'
  return proximo
}

/**
 * Recebe o ID token que o SDK cliente produziu e o troca por um cookie de
 * sessão httpOnly.
 *
 * O login em si acontece no browser — é o Firebase Auth que valida a senha.
 * O que o servidor faz aqui é verificar o token e assinar a sessão, para que
 * Server Component e Route Handler consigam saber quem é o usuário sem
 * depender de `localStorage`.
 */
export async function abrirSessao(
  _anterior: EstadoAuth,
  formData: FormData
): Promise<EstadoAuth> {
  const parsed = entrada.safeParse({
    idToken: formData.get('idToken'),
    proximo: formData.get('proximo') || undefined,
  })

  if (!parsed.success) return { erro: 'Sessão inválida. Tente entrar de novo.' }

  try {
    await criarSessao(parsed.data.idToken)
  } catch {
    return { erro: 'Não foi possível abrir a sessão. Tente de novo.' }
  }

  const sessao = await lerSessao()
  if (sessao) await garantirUsuario(sessao.uid, sessao.email)

  revalidatePath('/', 'layout')
  redirect(destinoSeguro(parsed.data.proximo))
}

export async function sair() {
  await encerrarSessao()
  revalidatePath('/', 'layout')
  redirect('/login')
}
