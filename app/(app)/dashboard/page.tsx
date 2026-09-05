import { exigirSessao } from '@/lib/firebase/session'
import { lerInsight, lerRollup } from '@/lib/firestore/repo'
import { formatCents } from '@/lib/domain/money'
import { CATEGORIAS, CATEGORIA_COR, CATEGORIA_LABEL } from '@/lib/domain/categories'
import { mesAnterior, mesAtual, mesLegivel, mesValido } from '@/lib/domain/month'
import { CategoryChart, type FatiaCategoria } from './category-chart'
import { InsightsPanel } from './insights-panel'

export default async function DashboardPage({ searchParams }: PageProps<'/dashboard'>) {
  const { uid, email } = await exigirSessao()
  const params = await searchParams

  const mes = mesValido(params.mes) ? params.mes : mesAtual()
  const anterior = mesAnterior(mes)
  const [rollup, rollupAnterior, insight] = await Promise.all([
    lerRollup(uid, mes),
    lerRollup(uid, anterior),
    lerInsight(uid, mes),
  ])

  const fatias: FatiaCategoria[] = CATEGORIAS.filter(
    (categoria) => rollup.byCategory[categoria] < 0
  ).map((category) => ({
    category,
    label: CATEGORIA_LABEL[category],
    value: Math.abs(rollup.byCategory[category]),
    color: CATEGORIA_COR[category],
  }))

  const maior = [...fatias].sort((a, b) => b.value - a.value)[0]
  const saldo = rollup.totalInCents + rollup.totalOutCents

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-neutral-500">{email} · {mesLegivel(mes)}</p>
      </div>

      <form className="flex items-end gap-3" method="get">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Mês</span>
          <input
            type="month"
            name="mes"
            defaultValue={mes}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <button className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
          Ver período
        </button>
      </form>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Cartao rotulo="Total gasto" valor={formatCents(Math.abs(rollup.totalOutCents))} />
        <Cartao rotulo="Total recebido" valor={formatCents(rollup.totalInCents)} />
        <Cartao rotulo="Saldo" valor={formatCents(saldo)} destaque={saldo >= 0} />
        <Cartao rotulo="Maior categoria" valor={maior?.label ?? '—'} detalhe={maior ? formatCents(maior.value) : undefined} />
      </div>

      <div className="rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="text-base font-semibold">Gastos por categoria</h2>
        <p className="mt-1 text-sm text-neutral-500">Clique em uma fatia para ver as transações.</p>
        {fatias.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Nenhum gasto neste mês ainda. Importe um extrato para começar.
          </p>
        ) : (
          <CategoryChart data={fatias} month={mes} />
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
          <h2 className="font-semibold">Comparação com {mesLegivel(anterior)}</h2>
        </div>
        <table className="w-full text-left text-sm">
          <thead className="text-neutral-500">
            <tr>
              <th className="px-5 py-2 font-medium">Categoria</th>
              <th className="px-5 py-2 text-right font-medium">Mês atual</th>
              <th className="px-5 py-2 text-right font-medium">Mês anterior</th>
              <th className="px-5 py-2 text-right font-medium">Variação</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIAS.filter((categoria) => categoria !== 'receita').map((categoria) => {
              const atual = Math.abs(Math.min(0, rollup.byCategory[categoria]))
              const antes = Math.abs(Math.min(0, rollupAnterior.byCategory[categoria]))
              const percentual = antes === 0 ? null : ((atual - antes) / antes) * 100
              return (
                <tr key={categoria} className="border-t border-neutral-100 dark:border-neutral-900">
                  <td className="px-5 py-2.5">{CATEGORIA_LABEL[categoria]}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{formatCents(atual)}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{formatCents(antes)}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">
                    {percentual === null ? (atual > 0 ? 'novo' : '—') : `${percentual >= 0 ? '+' : ''}${percentual.toFixed(0)}%`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <InsightsPanel
        month={mes}
        initial={insight ? { body: insight.body, model: insight.model } : null}
      />
    </div>
  )
}

function Cartao({
  rotulo,
  valor,
  detalhe,
  destaque,
}: {
  rotulo: string
  valor: string
  detalhe?: string
  destaque?: boolean
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-sm text-neutral-500">{rotulo}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${destaque ? 'text-emerald-700 dark:text-emerald-400' : ''}`}>{valor}</p>
      {detalhe && <p className="mt-1 text-xs text-neutral-500">{detalhe}</p>}
    </div>
  )
}
