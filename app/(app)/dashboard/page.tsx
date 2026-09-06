import { exigirSessao } from '@/lib/firebase/session'
import { lerInsight, lerRollup } from '@/lib/firestore/repo'
import { formatCents } from '@/lib/domain/money'
import { CATEGORIAS, CATEGORIA_COR, CATEGORIA_LABEL } from '@/lib/domain/categories'
import { mesAnterior, mesAtual, mesLegivel, mesValido } from '@/lib/domain/month'
import { Numero } from '../numero'
import { CategoryChart, type FatiaCategoria } from './category-chart'
import { InsightsPanel } from './insights-panel'
import {
  categoriasLiquidas,
  gastoBrutoCents,
  totalNetExpenseCents,
  totalRefundCents,
} from '@/lib/firestore/rollup'

export default async function DashboardPage({ searchParams }: PageProps<'/dashboard'>) {
  const { uid } = await exigirSessao()
  const params = await searchParams

  const mes = mesValido(params.mes) ? params.mes : mesAtual()
  const anterior = mesAnterior(mes)
  const [rollup, rollupAnterior, insight] = await Promise.all([
    lerRollup(uid, mes),
    lerRollup(uid, anterior),
    lerInsight(uid, mes),
  ])

  // As fatias são o gasto BRUTO por categoria, e por isso somam exatamente
  // `gastoBrutoCents` — o critério de aceite da spec §8. O estorno não é
  // subtraído aqui porque ele não tem onde aparecer numa pizza: crédito é
  // fatia negativa, e fatia negativa não existe. Ele entra como número
  // próprio, ao lado, onde dá para lê-lo.
  const fatias: FatiaCategoria[] = CATEGORIAS.filter(
    (categoria) => rollup.byCategory[categoria] < 0
  ).map((category) => ({
    category,
    label: CATEGORIA_LABEL[category],
    value: Math.abs(rollup.byCategory[category]),
    color: CATEGORIA_COR[category],
  }))

  const maior = [...fatias].sort((a, b) => b.value - a.value)[0]
  const bruto = gastoBrutoCents(rollup)
  const estornos = totalRefundCents(rollup)
  const gastoLiquido = totalNetExpenseCents(rollup)
  const saldo = rollup.totalInCents - gastoLiquido
  const liquidoPorCategoria = categoriasLiquidas(rollup)
  const liquidoAnteriorPorCategoria = categoriasLiquidas(rollupAnterior)
  const gastos = CATEGORIAS.filter((c) => c !== 'receita')

  return (
    <div className="flex flex-col gap-12">
      {/* Cabeçalho: o mês é o assunto da página, então ele é o título — em
          serifada e grande. O seletor fica discreto ao lado, porque trocar de
          mês é ação secundária. */}
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="rotulo">Resumo do mês</p>
          <h1 className="mt-2 font-display text-4xl leading-none tracking-tight sm:text-5xl">
            {mesLegivel(mes)}
          </h1>
        </div>

        <form className="flex items-center gap-2" method="get">
          <input
            type="month"
            name="mes"
            defaultValue={mes}
            aria-label="Mês"
            className="superficie superficie-interativa px-3 py-2 text-sm text-suave"
          />
          <button className="rounded-md border border-linha-forte px-4 py-2 text-sm text-suave transition-colors duration-300 hover:border-texto hover:text-texto">
            Ver
          </button>
        </form>
      </header>

      {/* Os quatro números.
          Sem cartões com borda: as hairlines verticais bastam para separar, e
          borda em tudo é o que mais "aperta" uma interface. O valor em tamanho
          grande e peso leve — número grande e pesado grita; grande e leve tem
          dinheiro. */}
      {/* O `bg-linha` do pai aparece pelos vãos de 1px do `gap-px` e vira a
          divisória — sem desenhar borda em célula nenhuma, que é o que
          duplicaria traço nos encontros. */}
      <section className="grid gap-px border-y border-linha bg-linha sm:grid-cols-2 lg:grid-cols-5">
        <Numero
          rotulo="Total gasto"
          valor={formatCents(gastoLiquido)}
          // O detalhe existe para a conta fechar na tela: sem ele, a pizza
          // soma o bruto e o card mostra o líquido, e a diferença fica sem
          // explicação nenhuma à vista.
          detalhe={
            estornos > 0
              ? `${formatCents(bruto)} − ${formatCents(estornos)} em estornos`
              : undefined
          }
        />
        <Numero rotulo="Total recebido" valor={formatCents(rollup.totalInCents)} entrada />
        <Numero
          rotulo="Pagamentos / transf."
          valor={formatCents(rollup.totalTransferCents)}
        />
        <Numero rotulo="Saldo" valor={formatCents(saldo)} entrada={saldo >= 0} />
        <Numero
          rotulo="Maior categoria"
          valor={maior?.label ?? '—'}
          detalhe={maior ? formatCents(maior.value) : undefined}
          cor={maior ? CATEGORIA_COR[maior.category] : undefined}
        />
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-2xl">Onde o dinheiro foi</h2>
          {fatias.length > 0 && (
            <p className="text-xs text-fraco">Clique numa fatia para ver as transações</p>
          )}
        </div>

        {fatias.length === 0 ? (
          <Vazio />
        ) : (
          <div className="mt-6">
            <CategoryChart
              data={fatias}
              month={mes}
              rotuloTotal={estornos > 0 ? 'Gasto bruto' : 'Total'}
            />
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-2xl">
          Contra {mesLegivel(anterior)}
        </h2>

        <table className="mt-6 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-linha">
              <th className="rotulo pb-3 font-medium">Categoria</th>
              <th className="rotulo pb-3 text-right font-medium">Agora</th>
              <th className="rotulo pb-3 text-right font-medium">Antes</th>
              <th className="rotulo pb-3 text-right font-medium">Variação</th>
            </tr>
          </thead>
          <tbody>
            {gastos.map((categoria) => {
              // Comparação mês a mês é sobre o que de fato saiu do bolso,
              // então aqui é o LÍQUIDO — senão uma devolução grande não
              // apareceria como queda nenhuma.
              const atual = Math.abs(Math.min(0, liquidoPorCategoria[categoria]))
              const antes = Math.abs(Math.min(0, liquidoAnteriorPorCategoria[categoria]))
              const percentual = antes === 0 ? null : ((atual - antes) / antes) * 100
              const vazia = atual === 0 && antes === 0

              return (
                <tr
                  key={categoria}
                  className="border-b border-linha last:border-0"
                  // Categoria sem movimento nos dois meses fica recuada em vez
                  // de sumir: a lista completa é informação, mas não pode
                  // competir com o que teve gasto.
                  style={vazia ? { opacity: 0.35 } : undefined}
                >
                  <td className="py-3">
                    <span className="flex items-center gap-2.5">
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full"
                        style={{ background: CATEGORIA_COR[categoria] }}
                      />
                      {CATEGORIA_LABEL[categoria]}
                    </span>
                  </td>
                  <td className="valor py-3 text-right">{formatCents(atual)}</td>
                  <td className="valor py-3 text-right text-suave">{formatCents(antes)}</td>
                  <td className="valor py-3 text-right">
                    <Variacao percentual={percentual} temAtual={atual > 0} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <InsightsPanel
        month={mes}
        initial={insight ? { body: insight.body, model: insight.model } : null}
      />
    </div>
  )
}

/**
 * Gasto não é vermelho.
 *
 * Num app de finanças pessoais quase toda linha é despesa — pintar tudo de
 * vermelho é alarme constante, e alarme constante não é alarme nenhum. Aqui o
 * sinal é discreto: só a seta e o tom do texto mudam.
 */
function Variacao({ percentual, temAtual }: { percentual: number | null; temAtual: boolean }) {
  if (percentual === null) {
    return <span className="text-fraco">{temAtual ? 'novo' : '—'}</span>
  }

  const subiu = percentual > 0
  const parado = Math.abs(percentual) < 1

  if (parado) return <span className="text-fraco">estável</span>

  return (
    <span className={subiu ? 'text-texto' : 'text-suave'}>
      {subiu ? '↑' : '↓'} {Math.abs(percentual).toFixed(0)}%
    </span>
  )
}

function Vazio() {
  return (
    <div className="mt-6 border border-dashed border-linha px-8 py-16 text-center">
      <p className="text-sm text-suave">Nenhum gasto registrado neste mês.</p>
      <a
        href="/importar"
        className="mt-3 inline-block text-sm text-texto underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:decoration-texto"
      >
        Importar um extrato
      </a>
    </div>
  )
}
