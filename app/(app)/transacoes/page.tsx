import { exigirSessao } from '@/lib/firebase/session'
import { listarTransacoesDoMes, lerRollup } from '@/lib/firestore/repo'
import { formatCents } from '@/lib/domain/money'
import { CATEGORIAS, CATEGORIA_LABEL, type Categoria } from '@/lib/domain/categories'
import { sugerirPadrao } from '@/lib/domain/rules'
import { mesAnterior, mesAtual, mesLegivel, mesSeguinte, mesValido } from '@/lib/domain/month'
import { alterarOptOut, corrigirCategoria } from './actions'

export default async function TransacoesPage({
  searchParams,
}: PageProps<'/transacoes'>) {
  const { uid } = await exigirSessao()

  const params = await searchParams
  const bruto = typeof params.mes === 'string' ? params.mes : null
  const mes = mesValido(bruto) ? bruto : mesAtual()

  const categoriaBruta = typeof params.categoria === 'string' ? params.categoria : null
  const categoria = CATEGORIAS.includes(categoriaBruta as Categoria)
    ? (categoriaBruta as Categoria)
    : null

  const [todas, rollup] = await Promise.all([
    listarTransacoesDoMes(uid, mes),
    lerRollup(uid, mes),
  ])
  const transacoes = categoria
    ? todas.filter((transacao) => (transacao.category ?? 'outros') === categoria)
    : todas

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

      <form className="flex flex-wrap items-end gap-3" method="get">
        <input type="hidden" name="mes" value={mes} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Categoria</span>
          <select
            name="categoria"
            defaultValue={categoria ?? ''}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">Todas</option>
            {CATEGORIAS.map((item) => (
              <option value={item} key={item}>{CATEGORIA_LABEL[item]}</option>
            ))}
          </select>
        </label>
        <button className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">
          Filtrar
        </button>
      </form>

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
                  <th className="min-w-80 px-4 py-2.5 font-medium">Categoria e regra</th>
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
                    <td className="px-4 py-2.5 align-top">
                      <form action={corrigirCategoria} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="fingerprint" value={t.fingerprint} />
                        <select
                          name="category"
                          defaultValue={t.category ?? 'outros'}
                          aria-label={`Categoria de ${t.descriptionRaw}`}
                          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                        >
                          {(t.amountCents >= 0 ? ['receita'] as const : CATEGORIAS).map((item) => (
                            <option value={item} key={item}>{CATEGORIA_LABEL[item]}</option>
                          ))}
                        </select>
                        <input
                          name="pattern"
                          defaultValue={sugerirPadrao(t.descriptionClean)}
                          aria-label="Padrão para próximas transações"
                          title="Edite ou apague para não criar uma regra"
                          className="min-w-40 flex-1 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                        />
                        <button className="rounded bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900">
                          Salvar
                        </button>
                      </form>
                      <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                        <span>{t.categorySource ? `origem: ${t.categorySource}` : 'não categorizada'}</span>
                        <form action={alterarOptOut}>
                          <input type="hidden" name="fingerprint" value={t.fingerprint} />
                          <input type="hidden" name="optOut" value={String(!t.aiOptOut)} />
                          <button className="underline underline-offset-2">
                            {t.aiOptOut ? 'permitir IA' : 'não enviar à IA'}
                          </button>
                        </form>
                      </div>
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
            {transacoes.length} transação(ões){categoria ? ` em ${CATEGORIA_LABEL[categoria]}` : ''}.
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
