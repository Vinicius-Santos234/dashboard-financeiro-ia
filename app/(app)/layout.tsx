import Link from 'next/link'
import { redirect } from 'next/navigation'
import { lerSessao } from '@/lib/firebase/session'
import { sair } from '../(auth)/login/actions'
import { Marca } from '@/components/marca'

const NAV = [
  { href: '/dashboard', label: 'Resumo' },
  { href: '/transacoes', label: 'Transações' },
  { href: '/importar', label: 'Importar' },
  { href: '/conta', label: 'Conta' },
]

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Aqui a sessão é VERIFICADA (assinatura conferida no Admin SDK), diferente
  // do proxy.ts, que só olha se o cookie existe. Spec §4.4.
  const sessao = await lerSessao()
  if (!sessao) redirect('/login')

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Cabeçalho sem caixa e sem fundo próprio: só uma hairline embaixo.
          Barra com fundo diferente é o que faz um app parecer painel de
          administração — e a referência aqui é o oposto disso. */}
      <header className="border-b border-linha">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-10 px-6 py-5">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 transition-opacity duration-300 hover:opacity-80"
          >
            <Marca size={26} />
            <span className="font-display text-lg leading-none tracking-tight">
              Dashboard&nbsp;Financeiro
            </span>
          </Link>

          <nav className="hidden items-center gap-6 sm:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm text-suave transition-colors duration-300 hover:text-texto"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            {sessao.demo && (
              // A demo precisa se anunciar: sem isto, quem clica em algo que
              // não funciona acha que o app está quebrado, e não que a conta é
              // de demonstração.
              <span className="rotulo hidden border border-linha px-2 py-1 sm:inline-block">
                Demonstração
              </span>
            )}
            <form action={sair}>
              <button
                type="submit"
                className="text-sm text-fraco transition-colors duration-300 hover:text-texto"
              >
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl grow px-6 py-14">{children}</main>

      <Rodape email={sessao.email} demo={sessao.demo} />
    </div>
  )
}

/**
 * O rodapé.
 *
 * A versão anterior só repetia o e-mail — informação que já está na tela de
 * Conta e que não ajuda ninguém a fazer nada. Aqui ele passa a carregar as
 * duas coisas que o app precisa dizer sobre si mesmo e que não cabem em
 * nenhuma outra tela: **o que ele faz com o seu dado** e **que é um projeto
 * pessoal**.
 *
 * É também onde a promessa da privacidade fica visível o tempo todo, em vez de
 * enterrada no README que ninguém abre.
 */
function Rodape({ email, demo }: { email: string | null; demo: boolean }) {
  return (
    <footer className="mt-8 border-t border-linha">
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="grid gap-8 sm:grid-cols-[1fr_auto]">
          <div className="max-w-md">
            <p className="rotulo">Sobre os seus dados</p>
            <p className="mt-3 text-sm leading-relaxed text-suave">
              O extrato enviado é lido em memória e descartado — só as
              transações ficam. Antes de qualquer chamada à IA, CPF, agência,
              conta e contraparte são removidos da descrição.
            </p>
            <Link
              href="/conta"
              className="mt-3 inline-block text-sm text-fraco underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-texto"
            >
              Ver ou excluir seus dados
            </Link>
          </div>

          <nav className="flex flex-col gap-2 sm:items-end">
            <p className="rotulo">Navegar</p>
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm text-suave transition-colors duration-300 hover:text-texto"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-linha pt-6">
          <p className="text-xs text-fraco">
            {demo ? 'Conta de demonstração' : email}
          </p>
          <p className="text-xs text-fraco">
            Projeto pessoal · sem garantia de disponibilidade
          </p>
        </div>
      </div>
    </footer>
  )
}
