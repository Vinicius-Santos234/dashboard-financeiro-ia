import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/** Rotas que existem sem sessão. Todo o resto exige login. */
const PUBLICAS = ['/login', '/auth']

/**
 * Renova a sessão a cada request e barra quem não tem sessão.
 *
 * Isto é conveniência de navegação, NÃO é a proteção dos dados: quem protege
 * os dados é a RLS no Postgres (migration 0001). Se este middleware falhar, o
 * pior que acontece é uma tela vazia — não um vazamento. Spec §4.4.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    }
  )

  // getUser() e não getSession(): getSession lê o cookie sem validar a
  // assinatura no servidor de auth, e cookie é dado do cliente.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const ehPublica = PUBLICAS.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )

  if (!user && !ehPublica) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    // Guarda para onde a pessoa queria ir, para voltar depois do login.
    if (pathname !== '/') url.searchParams.set('proximo', pathname)
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}
