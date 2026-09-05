import { CATEGORIA_LABEL } from '@/lib/domain/categories'
import { exigirSessao } from '@/lib/firebase/session'
import { listarImports, listarRegras } from '@/lib/firestore/repo'
import { excluirConta } from './actions'

export const maxDuration = 60

export default async function ContaPage() {
  const { uid, email } = await exigirSessao()
  const [imports, regras] = await Promise.all([listarImports(uid), listarRegras(uid)])

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Conta</h1>
        <p className="mt-1 text-sm text-neutral-500">{email}</p>
      </div>

      <section className="rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="font-semibold">Privacidade</h2>
        <div className="mt-3 space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
          <p>O arquivo enviado é processado em memória e não é armazenado.</p>
          <p>Antes da categorização, CPF, CNPJ, contas, telefones, e-mails, chaves UUID e contrapartes de transferências são removidos.</p>
          <p>O nome do estabelecimento pode permanecer e revelar informação sensível. Você pode impedir o envio à IA em qualquer transação.</p>
          <p>Descrições anonimizadas e agregados podem ser processados pelo Google fora do Brasil.</p>
        </div>
      </section>

      <section className="rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
          <h2 className="font-semibold">Últimas importações</h2>
        </div>
        {imports.length === 0 ? (
          <p className="p-5 text-sm text-neutral-500">Nenhuma importação.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Arquivo</th>
                  <th className="px-5 py-2 font-medium">Período</th>
                  <th className="px-5 py-2 text-right font-medium">Importadas</th>
                  <th className="px-5 py-2 text-right font-medium">Duplicadas</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((item) => (
                  <tr key={item.id} className="border-t border-neutral-100 dark:border-neutral-900">
                    <td className="px-5 py-2.5">{item.filename}</td>
                    <td className="px-5 py-2.5 text-neutral-500">{item.periodStart ?? '—'} a {item.periodEnd ?? '—'}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{item.rowsImported}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{item.rowsDuplicated}</td>
                    <td className="px-5 py-2.5">{item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="font-semibold">Regras aprendidas</h2>
        {regras.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">Nenhuma correção salva ainda.</p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {regras.map((regra) => (
              <li key={regra.pattern} className="rounded-md bg-neutral-50 px-3 py-2 text-sm dark:bg-neutral-900">
                <span className="font-medium">{regra.pattern}</span>
                <span className="ml-2 text-neutral-500">→ {CATEGORIA_LABEL[regra.category]} · {regra.hits} uso(s)</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-red-200 p-6 dark:border-red-900">
        <h2 className="font-semibold text-red-700 dark:text-red-300">Excluir conta e dados</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          A exclusão remove permanentemente transações, imports, regras, insights, contas e o usuário do Firebase Auth.
        </p>
        <form action={excluirConta} className="mt-4 flex max-w-md flex-col gap-3">
          <label className="text-sm">
            <span className="mb-1 block">Digite <strong>EXCLUIR</strong> para confirmar</span>
            <input
              name="confirmacao"
              required
              pattern="EXCLUIR"
              autoComplete="off"
              className="w-full rounded-md border border-red-300 px-3 py-2 dark:border-red-800 dark:bg-neutral-950"
            />
          </label>
          <button className="self-start rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">
            Excluir permanentemente
          </button>
        </form>
      </section>
    </div>
  )
}
