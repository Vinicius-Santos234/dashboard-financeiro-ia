import { createClient } from '@/lib/supabase/server'
import { formatCents } from '@/lib/domain/money'

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Tudo passa pela RLS: nao existe filtro `.eq('user_id', ...)` aqui de
  // proposito. Se a policy sumir, o teste tests/rls.test.ts quebra — e nao
  // um `if` esquecido em alguma tela.
  const { count } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-neutral-500">{user?.email}</p>
      </div>

      <div className="rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
        <p className="text-sm text-neutral-500">Transacoes cadastradas</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{count ?? 0}</p>
        <p className="mt-4 text-sm text-neutral-500">
          Total: {formatCents(0)} — graficos entram na E5.
        </p>
      </div>
    </div>
  )
}
