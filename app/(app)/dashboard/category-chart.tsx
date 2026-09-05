'use client'

import { useRouter } from 'next/navigation'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { formatCents } from '@/lib/domain/money'
import type { Categoria } from '@/lib/domain/categories'

export interface FatiaCategoria {
  category: Categoria
  label: string
  value: number
  color: string
}

export function CategoryChart({ data, month }: { data: FatiaCategoria[]; month: string }) {
  const router = useRouter()

  return (
    <div className="grid items-center gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="h-72 min-w-0" role="img" aria-label="Gastos por categoria">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={68}
              outerRadius={112}
              paddingAngle={2}
              stroke="transparent"
            >
              {data.map((item) => (
                <Cell
                  key={item.category}
                  fill={item.color}
                  className="cursor-pointer outline-none"
                  onClick={() =>
                    router.push(`/transacoes?mes=${month}&categoria=${item.category}`)
                  }
                />
              ))}
            </Pie>
            <Tooltip formatter={(valor) => formatCents(Number(valor))} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="flex flex-col gap-2 text-sm">
        {data.map((item) => (
          <li key={item.category}>
            <button
              type="button"
              onClick={() =>
                router.push(`/transacoes?mes=${month}&categoria=${item.category}`)
              }
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              <span className="flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                {item.label}
              </span>
              <span className="tabular-nums">{formatCents(item.value)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

