import { NextResponse, type NextRequest } from 'next/server'

/**
 * Proxy de navegação — e **só** de navegação.
 *
 * (Era `middleware.ts`. O Next 16 depreciou o nome e renomeou a convenção para
 * `proxy`, porque "middleware" era confundido com o do Express e sugeria um
 * uso mais central do que a Vercel recomenda.)
 *
 * Aqui só se verifica se **existe** um cookie de sessão, para evitar o piscar
 * da tela protegida antes do redirecionamento. Quem valida a assinatura é
 * `lerSessao()` / `exigirSessao()` no layout e nas rotas.
 *
 * **Por que não validar aqui, já que daria.** Até o Next 15 a resposta era
 * técnica: o middleware rodava no Edge e o `firebase-admin` não funciona lá.
 * No Next 16 o Proxy roda em Node por padrão, então essa razão morreu — mas a
 * decisão continua, por três motivos melhores:
 *
 * 1. A própria documentação do Next diz para **não** depender do Proxy para
 *    autorização: Server Actions são POST para a rota onde são usadas, e uma
 *    mudança de `matcher` pode remover a cobertura em silêncio.
 * 2. O Proxy pode ser distribuído para a CDN, fora do runtime da aplicação.
 * 3. `verifySessionCookie(cookie, true)` consulta o servidor de auth para
 *    checar revogação. Fazer isso em **toda** requisição, inclusive nas que não
 *    tocam dado nenhum, é caro sem comprar segurança: quem lê dado é o
 *    servidor, e lá a sessão é verificada de qualquer jeito.
 *
 * Se este arquivo sumisse por inteiro, o pior que aconteceria é uma tela vazia
 * — não um vazamento.
 */

const PUBLICAS = ['/login', '/api/auth']

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  const ehPublica = PUBLICAS.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )

  if (!request.cookies.has('sessao') && !ehPublica) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    if (pathname !== '/') url.searchParams.set('proximo', pathname)
    return NextResponse.redirect(url)
  }

  // Deliberadamente NÃO existe aqui o caminho inverso ("tem cookie e está no
  // /login, manda para o /dashboard").
  //
  // A presença do cookie não prova que a sessão vale. Um cookie expirado ou
  // revogado passaria por aqui, seria mandado ao /dashboard, o layout recusaria
  // e mandaria de volta ao /login — e o Proxy de novo ao /dashboard, num loop
  // infinito que deixa a pessoa sem conseguir nem fazer login outra vez.
  //
  // Redirecionar por indício é aceitável para PROTEGER rota; para EXPULSAR de
  // uma rota pública, não.
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
