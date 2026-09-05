import { NextResponse, type NextRequest } from 'next/server'

/**
 * Middleware de navegação — e **só** de navegação.
 *
 * O middleware do Next roda no Edge, onde o `firebase-admin` não funciona (usa
 * APIs de Node). Então aqui não dá para verificar a assinatura do cookie: ele
 * checa apenas se **existe** um cookie de sessão, para evitar o piscar da tela
 * protegida antes do redirecionamento.
 *
 * Quem verifica de verdade é `lerSessao()` / `exigirSessao()` no layout e nas
 * rotas, que rodam em Node e conferem a assinatura a cada request. Um cookie
 * falsificado passa por aqui e morre lá — e não vê nenhum dado no caminho,
 * porque o `uid` que monta os caminhos do Firestore sai da verificação, não do
 * cookie cru.
 */

const PUBLICAS = ['/login', '/api/auth']

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const ehPublica = PUBLICAS.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )

  const temCookie = request.cookies.has('sessao')

  if (!temCookie && !ehPublica) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    if (pathname !== '/') url.searchParams.set('proximo', pathname)
    return NextResponse.redirect(url)
  }

  if (temCookie && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
