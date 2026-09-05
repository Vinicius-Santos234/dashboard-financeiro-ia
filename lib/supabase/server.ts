import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Cliente Supabase para Server Components, Route Handlers e Server Actions.
 *
 * Usa a chave publicável (não a `service_role`). Spec §4.4: a service_role
 * nunca entra em código de request — se um Route Handler precisar dela, o
 * desenho está errado, porque significa que a RLS está sendo contornada em
 * vez de respeitada.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Server Component não pode escrever cookie. Sem problema: quem
            // renova a sessão é o middleware, que roda antes e pode.
          }
        },
      },
    }
  )
}
