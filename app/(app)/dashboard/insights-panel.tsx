'use client'

import { useState } from 'react'
import { CATEGORIA_LABEL } from '@/lib/domain/categories'
import type { InsightBody } from '@/lib/llm/schema'

interface InsightExibido {
 body: InsightBody
 model: string
}

export function InsightsPanel({
 month,
 initial,
}: {
 month: string
 initial: InsightExibido | null
}) {
 const [insight, setInsight] = useState(initial)
 const [loading, setLoading] = useState(false)
 const [erro, setErro] = useState<string | null>(null)

 async function gerar(regenerate: boolean) {
 setLoading(true)
 setErro(null)
 try {
 const resposta = await fetch('/api/insights', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ month, regenerate }),
 })
 const json = await resposta.json()
 if (!resposta.ok) {
 setErro(json.erro ?? 'Não foi possível gerar o insight.')
 return
 }
 setInsight(json.insight)
 } catch {
 setErro('Não foi possível falar com o servidor.')
 } finally {
 setLoading(false)
 }
 }

 return (
 <section className="rounded-md border border-linha p-6 ">
 <div className="flex flex-wrap items-start justify-between gap-3">
 <div>
 <h2 className="font-semibold">Leitura do mês</h2>
 <p className="mt-1 text-sm text-suave">
 A IA recebe somente os totais por categoria, nunca as transações.
 </p>
 </div>
 <button
 type="button"
 disabled={loading}
 onClick={() => gerar(Boolean(insight))}
 className="rounded-md border border-linha-forte px-3 py-2 text-sm disabled:opacity-50 "
 >
 {loading ? 'Gerando…' : insight ? 'Regerar' : 'Gerar insight'}
 </button>
 </div>

 {erro && <p role="alert" className="mt-4 text-sm" style={{ color: 'var(--alarme)' }}>{erro}</p>}

 {insight ? (
 <div className="mt-5">
 <p className="text-lg font-medium">{insight.body.headline}</p>
 <ul className="mt-3 flex flex-col gap-2">
 {insight.body.items.map((item, indice) => (
 <li
 key={`${item.text}-${indice}`}
 className={`rounded-md border-l-4 px-3 py-2 text-sm ${
 item.severity === 'atencao'
 ? 'border-l-2'
 : 'border-l-2 border-linha-forte'
 }`}
 >
 {item.text}
 {item.category && (
 <span className="ml-2 text-xs text-suave">
 {CATEGORIA_LABEL[item.category]}
 </span>
 )}
 </li>
 ))}
 </ul>
 <p className="mt-3 text-xs text-suave">Modelo: {insight.model}</p>
 </div>
 ) : (
 <p className="mt-5 text-sm text-suave">Nenhum insight gerado para este mês.</p>
 )}
 </section>
 )
}

