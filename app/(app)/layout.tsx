import Link from 'next/link'
import { redirect } from 'next/navigation'
import { lerSessao } from '@/lib/firebase/session'
import { sair } from '../(auth)/login/actions'

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/transacoes', label: 'Transacoes' },
  { href: '/importar', label: 'Importar' },
  { href: '/conta', label: 'Conta' },
]

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Aqui a sessao e VERIFICADA (assinatura conferida no Admin SDK), diferente
  // do middleware, que so olha se o cookie existe. Spec 4.4.
  const sessao = await lerSessao()
  if (!sessao) redirect('/login')

  return (
    <div className="min-h-dvh">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
          <span className="text-sm font-semibold">Dashboard Financeiro</span>
          <nav className="flex gap-4 text-sm text-neutral-600 dark:text-neutral-400">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="hover:text-neutral-950 dark:hover:text-neutral-50"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <form action={sair} className="ml-auto">
            <button
              type="submit"
              className="text-sm text-neutral-500 hover:text-neutral-950 dark:hover:text-neutral-50"
            >
              Sair
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  )
}
