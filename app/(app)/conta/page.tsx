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
 <h1 className="font-display text-4xl leading-none tracking-tight">Conta</h1>
 <p className="mt-1 text-sm text-suave">{email}</p>
 </div>

 <section className="rounded-md border border-linha p-6 ">
 <h2 className="font-semibold">Privacidade</h2>
 <div className="mt-3 space-y-2 text-sm text-suave">
 <p>O arquivo enviado é processado em memória e não é armazenado.</p>
 <p>Antes da categorização, CPF, CNPJ, contas, telefones, e-mails, chaves UUID e contrapartes de transferências são removidos.</p>
 <p>O nome do estabelecimento pode permanecer e revelar informação sensível. A importação não envia dados à IA: revise as transações e bloqueie as sensíveis antes de autorizar a categorização. O bloqueio não desfaz envios anteriores.</p>
 <p>Descrições anonimizadas e agregados podem ser processados pelo Google fora do Brasil.</p>
 </div>
 </section>

 <section className="rounded-md border border-linha">
 <div className="border-b border-linha px-5 py-4 ">
 <h2 className="font-semibold">Últimas importações</h2>
 </div>
 {imports.length === 0 ? (
 <p className="p-5 text-sm text-suave">Nenhuma importação.</p>
 ) : (
 <div className="overflow-x-auto">
 <table className="w-full text-left text-sm">
 <thead className="text-suave">
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
 <tr key={item.id} className="border-t border-linha">
 <td className="px-5 py-2.5">{item.filename}</td>
 <td className="px-5 py-2.5 text-suave">{item.periodStart ?? '—'} a {item.periodEnd ?? '—'}</td>
 <td className="px-5 py-2.5 text-right tabular-nums">{item.rowsImported}</td>
 <td className="px-5 py-2.5 text-right tabular-nums">{item.rowsDuplicated}</td>
 <td className="px-5 py-2.5">{item.status}
 <a className="ml-2 underline" href={`/transacoes${item.periodStart ? `?mes=${item.periodStart.slice(0, 7)}` : ''}`}>
 Revisar pendências
 </a>
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </section>

 <section className="rounded-md border border-linha p-6 ">
 <h2 className="font-semibold">Regras aprendidas</h2>
 {regras.length === 0 ? (
 <p className="mt-2 text-sm text-suave">Nenhuma correção salva ainda.</p>
 ) : (
 <ul className="mt-3 grid gap-2 sm:grid-cols-2">
 {regras.map((regra) => (
 <li key={regra.pattern} className="rounded-md border border-linha px-3 py-2 text-sm">
 <span className="font-medium">{regra.pattern}</span>
 <span className="ml-2 text-suave">→ {CATEGORIA_LABEL[regra.category]} · {regra.hits} uso(s)</span>
 </li>
 ))}
 </ul>
 )}
 </section>

 <section className="rounded-md p-6"
        style={{ border: '1px solid color-mix(in oklab, var(--alarme) 40%, transparent)' }}>
 <h2 className="font-display text-xl" style={{ color: 'var(--alarme)' }}>Excluir conta e dados</h2>
 <p className="mt-2 text-sm text-suave">
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
 className="w-full rounded-md border border-linha-forte bg-transparent px-3 py-2 outline-none transition-colors duration-300 focus:border-texto"
 />
 </label>
 <button className="self-start rounded-md border border-linha-forte px-4 py-2 text-sm font-medium transition-colors duration-300">
 Excluir permanentemente
 </button>
 </form>
 </section>
 </div>
 )
}
