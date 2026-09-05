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
    <section className="rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Leitura do mês</h2>
          <p className="mt-1 text-sm text-neutral-500">
            A IA recebe somente os totais por categoria, nunca as transações.
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => gerar(Boolean(insight))}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-neutral-700"
        >
          {loading ? 'Gerando…' : insight ? 'Regerar' : 'Gerar insight'}
        </button>
      </div>

      {erro && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{erro}</p>}

      {insight ? (
        <div className="mt-5">
          <p className="text-lg font-medium">{insight.body.headline}</p>
          <ul className="mt-3 flex flex-col gap-2">
            {insight.body.items.map((item, indice) => (
              <li
                key={`${item.text}-${indice}`}
                className={`rounded-md border-l-4 px-3 py-2 text-sm ${
                  item.severity === 'atencao'
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40'
                    : 'border-sky-500 bg-sky-50 dark:bg-sky-950/40'
                }`}
              >
                {item.text}
                {item.category && (
                  <span className="ml-2 text-xs text-neutral-500">
                    {CATEGORIA_LABEL[item.category]}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-neutral-500">Modelo: {insight.model}</p>
        </div>
      ) : (
        <p className="mt-5 text-sm text-neutral-500">Nenhum insight gerado para este mês.</p>
      )}
    </section>
  )
}

