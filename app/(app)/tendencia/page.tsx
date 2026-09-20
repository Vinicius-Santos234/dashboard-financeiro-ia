import Link from 'next/link'
import { exigirSessao } from '@/lib/firebase/session'
import { lerRollups, origemDoMes } from '@/lib/firestore/repo'
import { formatCents } from '@/lib/domain/money'
import { CATEGORIAS, CATEGORIA_COR, CATEGORIA_LABEL } from '@/lib/domain/categories'
import { mesAnterior, mesAtual, mesCurto, mesLegivel, mesValido } from '@/lib/domain/month'
import { categoriasLiquidas, totalNetExpenseCents } from '@/lib/firestore/rollup'

/** Seis meses: cabe na tela sem rolagem horizontal e cobre um semestre. */
const JANELA = 6

/** Os N meses até `ate`, do mais antigo para o mais novo. */
function janelaDeMeses(ate: string, quantos: number): string[] {
  const meses = [ate]
  for (let i = 1; i < quantos; i += 1) meses.unshift(mesAnterior(meses[0]))
  return meses
}

/**
 * A tendência de N meses. Spec 003 §5 D7 e §8 C7.
 *
 * **Nenhuma coleção nova.** A série sai de N leituras de rollup feitas sob
 * demanda, e não de um agregado anual gravado: um segundo agregado é uma
 * segunda coisa para divergir da primeira, e o custo de manter agregado em dia
 * já foi cobrado uma vez.
 */
export default async function TendenciaPage({ searchParams }: PageProps<'/tendencia'>) {
  const { uid } = await exigirSessao()
  const params = await searchParams

  const ate = mesValido(params.ate) ? params.ate : mesAtual()
  const meses = janelaDeMeses(ate, JANELA)

  const rollups = await lerRollups(uid, meses)
  const ehFatura = (await origemDoMes(uid, rollups[rollups.length - 1])) === 'fatura'

  const liquidos = rollups.map(categoriasLiquidas)
  const totais = rollups.map(totalNetExpenseCents)

  /**
   * Categorias com movimento em **qualquer direção**, e não só as negativas.
   *
   * A versão anterior filtrava `< 0` e truncava o resto com `Math.min(0, …)`.
   * Uma categoria que num mês só teve estorno — comprar em agosto e a
   * devolução chegar em setembro — tem líquido **positivo**, sumia da tabela,
   * e o crédito dela continuava dentro do Total. As colunas somavam mais que
   * a linha Total, sem nada na tela explicando a diferença.
   *
   * É o mesmo erro que a 001 §4.5 já tinha corrigido no rollup: descartar a
   * fatia positiva e manter o efeito dela no total.
   */
  const gastos = CATEGORIAS.filter((c) => c !== 'receita')
  const comMovimento = gastos.filter((categoria) =>
    liquidos.some((mes) => mes[categoria] !== 0)
  )

  const maiorTotal = Math.max(...totais, 1)

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="rotulo">Últimos {JANELA} meses</p>
          <h1 className="mt-2 font-display text-4xl leading-none tracking-tight sm:text-5xl">
            Tendência
          </h1>
          <p className="mt-3 text-sm text-suave">
            {ehFatura
              ? 'Quanto cada fatura consumiu, e em que.'
              : 'Quanto saiu por mês, e em que.'}
          </p>
        </div>

        <form className="flex items-center gap-2" method="get">
          <input
            type="month"
            name="ate"
            defaultValue={ate}
            aria-label="Último mês da série"
            className="superficie superficie-interativa px-3 py-2 text-sm text-suave"
          />
          <button className="rounded-md border border-linha-forte px-4 py-2 text-sm text-suave transition-colors duration-300 hover:border-texto hover:text-texto">
            Ver
          </button>
        </form>
      </header>

      {/* As barras. Uma coluna por mês, altura proporcional ao maior total da
          janela — comparação relativa é a leitura que interessa aqui, e um
          eixo em reais só ocuparia espaço para dizer o mesmo. */}
      <section>
        <h2 className="sr-only">Total por mês</h2>
        <div className="flex items-end gap-2 border-b border-linha pb-px sm:gap-4">
          {meses.map((mes, i) => (
            <div key={mes} className="flex flex-1 flex-col items-center gap-3">
              <p className="valor text-xs text-suave">
                {totais[i] === 0 ? '—' : formatCents(totais[i])}
              </p>
              <div
                className="w-full bg-texto transition-all duration-500"
                style={{
                  height: `${Math.round((totais[i] / maiorTotal) * 160)}px`,
                  minHeight: totais[i] > 0 ? '2px' : '0',
                  opacity: mes === ate ? 1 : 0.4,
                }}
                aria-hidden
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2 pt-3 sm:gap-4">
          {meses.map((mes) => (
            <p key={mes} className="flex-1 text-center text-xs text-fraco">
              <Link
                href={`/dashboard?mes=${mes}`}
                className="transition-colors duration-300 hover:text-texto"
              >
                {mesCurto(mes)}
              </Link>
            </p>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-2xl">Por categoria</h2>

        {comMovimento.length === 0 ? (
          <div className="mt-6 border border-dashed border-linha px-8 py-16 text-center">
            <p className="text-sm text-suave">
              Nenhum gasto registrado nestes {JANELA} meses.
            </p>
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Gasto líquido por categoria, de {mesLegivel(meses[0])} a{' '}
                {mesLegivel(ate)}
              </caption>
              <thead>
                <tr className="border-b border-linha">
                  <th scope="col" className="rotulo pb-3 font-medium">
                    Categoria
                  </th>
                  {meses.map((mes) => (
                    <th
                      key={mes}
                      scope="col"
                      className="rotulo pb-3 text-right font-medium"
                    >
                      {mesCurto(mes)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comMovimento.map((categoria) => (
                  <tr key={categoria} className="border-b border-linha last:border-0">
                    <th scope="row" className="py-3 font-normal">
                      <span className="flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className="size-1.5 rounded-full"
                          style={{ background: CATEGORIA_COR[categoria] }}
                        />
                        {CATEGORIA_LABEL[categoria]}
                      </span>
                    </th>
                    {liquidos.map((mes, i) => {
                      // O líquido da categoria é negativo quando saiu dinheiro
                      // e positivo quando voltou. A coluna mostra o gasto, e
                      // o crédito aparece **com sinal** em vez de virar zero —
                      // é ele que explica a diferença para o Total.
                      const liquido = mes[categoria]
                      const gasto = Math.abs(Math.min(0, liquido))
                      const credito = Math.max(0, liquido)
                      return (
                        <td
                          key={meses[i]}
                          className="valor py-3 text-right"
                          style={
                            liquido === 0
                              ? { opacity: 0.35 }
                              : credito > 0
                                ? { color: 'var(--entrada)' }
                                : undefined
                          }
                        >
                          {liquido === 0
                            ? '—'
                            : credito > 0
                              ? `+${formatCents(credito)}`
                              : formatCents(gasto)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                <tr className="border-t border-linha-forte">
                  <th scope="row" className="py-3 font-medium">
                    Total
                  </th>
                  {totais.map((total, i) => (
                    <td key={meses[i]} className="valor py-3 text-right font-medium">
                      {total === 0 ? '—' : formatCents(total)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-6 text-xs text-fraco">
          Gasto líquido — compras menos estornos, na categoria de cada uma.
          Pagamentos e transferências ficam de fora.
        </p>
      </section>
    </div>
  )
}
