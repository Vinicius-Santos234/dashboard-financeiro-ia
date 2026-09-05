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

  // Deliberadamente NÃO existe aqui o caminho inverso ("tem cookie e está no
  // /login, manda para o /dashboard").
  //
  // A presença do cookie não prova que a sessão vale, e quem verifica de
  // verdade é o layout, em Node. Um cookie expirado ou revogado passaria por
  // aqui, seria mandado ao /dashboard, o layout recusaria e mandaria de volta
  // ao /login — e o middleware de novo ao /dashboard, num loop infinito que
  // deixa a pessoa sem conseguir nem fazer login outra vez.
  //
  // Quem manda o usuário já autenticado para o dashboard é a própria página de
  // login, depois de a sessão ser verificada. Redirecionar por indício é
  // aceitável para PROTEGER rota; para EXPULSAR de uma rota pública, não.
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
