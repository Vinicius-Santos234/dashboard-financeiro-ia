import { exigirSessao } from '@/lib/firebase/session'
import { listarTransacoesDoMes, lerRollup } from '@/lib/firestore/repo'
import { formatCents } from '@/lib/domain/money'
import { CATEGORIA_LABEL } from '@/lib/domain/categories'
import { mesDe } from '@/lib/firestore/rollup'

function mesLegivel(mes: string): string {
  const [ano, m] = mes.split('-')
  const nomes = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  ]
  return `${nomes[Number(m) - 1]} de ${ano}`
}

/** `2026-08` → `2026-07`, sem passar por Date (que traria fuso de volta). */
function mesAnterior(mes: string): string {
  const [ano, m] = mes.split('-').map(Number)
  return m === 1
    ? `${ano - 1}-12`
    : `${ano}-${String(m - 1).padStart(2, '0')}`
}

function mesSeguinte(mes: string): string {
  const [ano, m] = mes.split('-').map(Number)
  return m === 12
    ? `${ano + 1}-01`
    : `${ano}-${String(m + 1).padStart(2, '0')}`
}

export default async function TransacoesPage({
  searchParams,
}: PageProps<'/transacoes'>) {
  const { uid } = await exigirSessao()

  const params = await searchParams
  const bruto = typeof params.mes === 'string' ? params.mes : null
  const mes = bruto && /^\d{4}-\d{2}$/.test(bruto)
    ? bruto
    : mesDe(new Date().toISOString().slice(0, 10))

  const [transacoes, rollup] = await Promise.all([
    listarTransacoesDoMes(uid, mes),
    lerRollup(uid, mes),
  ])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Transações</h1>
          <p className="mt-1 text-sm text-neutral-500">{mesLegivel(mes)}</p>
        </div>

        <nav className="flex items-center gap-2 text-sm">
          <a
            href={`/transacoes?mes=${mesAnterior(mes)}`}
            className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            ← anterior
          </a>
          <a
            href={`/transacoes?mes=${mesSeguinte(mes)}`}
            className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            seguinte →
          </a>
        </nav>
      </div>

      {transacoes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-500">
            Nenhuma transação em {mesLegivel(mes)}.
          </p>
          <a
            href="/importar"
            className="mt-2 inline-block text-sm underline underline-offset-4"
          >
            Importar um extrato
          </a>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Cartao rotulo="Entradas" valor={formatCents(rollup.totalInCents)} />
            <Cartao rotulo="Saídas" valor={formatCents(rollup.totalOutCents)} />
            <Cartao
              rotulo="Saldo"
              valor={formatCents(rollup.totalInCents + rollup.totalOutCents)}
            />
          </div>

          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Data</th>
                  <th className="px-4 py-2.5 font-medium">Descrição</th>
                  <th className="px-4 py-2.5 font-medium">Categoria</th>
                  <th className="px-4 py-2.5 text-right font-medium">Valor</th>
                </tr>
              </thead>
              <tbody>
                {transacoes.map((t) => (
                  <tr
                    key={t.fingerprint}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-neutral-500">
                      {t.occurredOn.split('-').reverse().join('/')}
                    </td>
                    <td className="px-4 py-2.5">{t.descriptionRaw}</td>
                    <td className="px-4 py-2.5">
                      {t.category ? (
                        <span className="text-neutral-600 dark:text-neutral-400">
                          {CATEGORIA_LABEL[t.category]}
                        </span>
                      ) : (
                        // Sem IA ainda: a E4 preenche isto. Mostrar o vazio de
                        // forma explícita evita a impressão de que "Outros" foi
                        // uma decisão do modelo.
                        <span className="text-neutral-400 dark:text-neutral-600">
                          —
                        </span>
                      )}
                    </td>
                    <td
                      className={`whitespace-nowrap px-4 py-2.5 text-right tabular-nums ${
                        t.amountCents >= 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : ''
                      }`}
                    >
                      {formatCents(t.amountCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-sm text-neutral-500">
            {transacoes.length} transações. Categorização por IA entra na E4.
          </p>
        </>
      )}
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
