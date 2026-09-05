'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'

export type EstadoAuth = {
  erro?: string
  email?: string
}

const credenciais = z.object({
  email: z.email('E-mail inválido.'),
  senha: z.string().min(8, 'A senha precisa de pelo menos 8 caracteres.'),
})

/**
 * Só aceita caminho relativo do próprio app.
 *
 * Sem isto, `?proximo=https://site-falso` transforma a tela de login num
 * redirecionador aberto: o link parece do app, a pessoa faz login e é jogada
 * para fora. `//host` também é absoluto (protocol-relative) e por isso entra
 * na checagem.
 */
function destinoSeguro(proximo: FormDataEntryValue | null): string {
  if (typeof proximo !== 'string') return '/dashboard'
  if (!proximo.startsWith('/') || proximo.startsWith('//')) return '/dashboard'
  return proximo
}

export async function entrar(
  _anterior: EstadoAuth,
  formData: FormData
): Promise<EstadoAuth> {
  const email = String(formData.get('email') ?? '')
  const parsed = credenciais.safeParse({ email, senha: formData.get('senha') })

  // O e-mail volta no estado de propósito: no React 19 o <form action> dá
  // reset ao terminar a action, inclusive quando ela devolve erro. Sem
  // devolver o valor, a pessoa erra a senha e perde o e-mail digitado junto.
  if (!parsed.success) {
    return { erro: parsed.error.issues[0].message, email }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.senha,
  })

  if (error) {
    // Mensagem genérica de propósito: dizer "e-mail não existe" entrega quais
    // contas existem para quem estiver testando de fora.
    return { erro: 'E-mail ou senha incorretos.', email }
  }

  revalidatePath('/', 'layout')
  redirect(destinoSeguro(formData.get('proximo')))
}

export async function cadastrar(
  _anterior: EstadoAuth,
  formData: FormData
): Promise<EstadoAuth> {
  const email = String(formData.get('email') ?? '')
  const parsed = credenciais.safeParse({ email, senha: formData.get('senha') })

  if (!parsed.success) {
    return { erro: parsed.error.issues[0].message, email }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.senha,
  })

  if (error) {
    return { erro: error.message, email }
  }

  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

export async function sair() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  revalidatePath('/', 'layout')
  redirect('/login')
}
