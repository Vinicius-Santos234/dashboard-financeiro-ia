import { exigirSessao } from '@/lib/firebase/session'
import { contarTransacoes, lerRollup } from '@/lib/firestore/repo'
import { formatCents } from '@/lib/domain/money'
import { CATEGORIAS, CATEGORIA_LABEL } from '@/lib/domain/categories'
import { mesDe } from '@/lib/firestore/rollup'

export default async function DashboardPage() {
  const { uid, email } = await exigirSessao()

  // Todo acesso passa o uid como primeiro argumento e monta o caminho a partir
  // dele — nao existe query global para esquecer de filtrar. Spec 3.1.
  const mes = mesDe(new Date().toISOString().slice(0, 10))
  const [total, rollup] = await Promise.all([
    contarTransacoes(uid),
    lerRollup(uid, mes),
  ])

  const gastos = CATEGORIAS.filter((c) => rollup.byCategory[c] < 0)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-neutral-500">{email}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Cartao rotulo="Transacoes" valor={String(total)} />
        <Cartao rotulo={`Entradas em ${mes}`} valor={formatCents(rollup.totalInCents)} />
        <Cartao rotulo={`Saidas em ${mes}`} valor={formatCents(rollup.totalOutCents)} />
      </div>

      <div className="rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
        <p className="text-sm font-medium">Por categoria</p>
        {gastos.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Nenhum gasto neste mes ainda. Importe um extrato para comecar.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5 text-sm">
            {gastos.map((c) => (
              <li key={c} className="flex justify-between tabular-nums">
                <span>{CATEGORIA_LABEL[c]}</span>
                <span>{formatCents(rollup.byCategory[c])}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-neutral-500">
          Uma leitura de documento desenha isto inteiro. Graficos entram na E5.
        </p>
      </div>
    </div>
  )
}

function Cartao({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-sm text-neutral-500">{rotulo}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{valor}</p>
    </div>
  )
}
