'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'
import { formatCents } from '@/lib/domain/money'
import type { Categoria } from '@/lib/domain/categories'

export interface FatiaCategoria {
  category: Categoria
  label: string
  value: number
  color: string
}

/**
 * Rosca fina, e não pizza cheia.
 *
 * Pizza é a forma mais "planilha de escritório" que existe. Um anel fino deixa
 * o centro livre para o total — que é o número que a pessoa realmente quer — e
 * transforma o gráfico numa moldura em volta de uma informação, em vez de num
 * disco colorido.
 *
 * O tooltip padrão do Recharts foi removido: ele vem com fundo branco e sombra,
 * e não há como deixá-lo elegante sem reescrever. No lugar, passar o mouse
 * destaca a fatia E a linha correspondente da legenda, e o centro passa a
 * mostrar aquela categoria. Um só lugar para ler, em vez de uma caixinha
 * flutuante perseguindo o cursor.
 */
export function CategoryChart({
  data,
  month,
  rotuloTotal = 'Total',
}: {
  data: FatiaCategoria[]
  month: string
  /**
   * O que o centro chama a soma das fatias.
   *
   * Existe porque, havendo estorno no mês, essa soma é o gasto **bruto** — e o
   * card ao lado mostra o líquido. Dois números diferentes rotulados "Total"
   * na mesma tela é o tipo de coisa que faz a pessoa achar que o app erra a
   * conta.
   */
  rotuloTotal?: string
}) {
  const router = useRouter()
  const [ativa, setAtiva] = useState<Categoria | null>(null)

  const total = data.reduce((soma, item) => soma + item.value, 0)
  const emFoco = data.find((item) => item.category === ativa)

  const abrir = (categoria: Categoria) =>
    router.push(`/transacoes?mes=${month}&categoria=${categoria}`)

  return (
    <div className="grid items-center gap-10 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <div className="relative h-64" role="img" aria-label="Gastos por categoria">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius="76%"
              outerRadius="100%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={1.5}
              // O traço na cor do fundo cria a fresta entre as fatias sem
              // desenhar uma borda — o vão é sombra, não linha.
              stroke="var(--fundo)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((item) => (
                <Cell
                  key={item.category}
                  fill={item.color}
                  className="cursor-pointer outline-none transition-opacity duration-300"
                  opacity={ativa === null || ativa === item.category ? 1 : 0.25}
                  onMouseEnter={() => setAtiva(item.category)}
                  onMouseLeave={() => setAtiva(null)}
                  onClick={() => abrir(item.category)}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* O centro. Sem foco mostra o total; com foco, a categoria. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <p className="rotulo">{emFoco ? emFoco.label : rotuloTotal}</p>
          <p className="valor mt-1.5 text-xl font-light">
            {formatCents(emFoco ? emFoco.value : total)}
          </p>
          {emFoco && (
            <p className="valor mt-1 text-xs text-fraco">
              {((emFoco.value / total) * 100).toFixed(0)}% do mês
            </p>
          )}
        </div>
      </div>

      {/* A legenda é a lista clicável. Sem fundo de hover: o que muda é a
          luminosidade do texto e a régua embaixo — o mesmo vocabulário do
          resto do app. */}
      <ul className="flex flex-col">
        {data.map((item) => (
          <li key={item.category}>
            <button
              type="button"
              onMouseEnter={() => setAtiva(item.category)}
              onMouseLeave={() => setAtiva(null)}
              onFocus={() => setAtiva(item.category)}
              onBlur={() => setAtiva(null)}
              onClick={() => abrir(item.category)}
              className="flex w-full items-baseline justify-between gap-4 border-b border-linha py-2.5 text-left text-sm transition-opacity duration-300"
              style={{ opacity: ativa === null || ativa === item.category ? 1 : 0.4 }}
            >
              <span className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                {item.label}
              </span>
              <span className="valor shrink-0 text-suave">{formatCents(item.value)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
