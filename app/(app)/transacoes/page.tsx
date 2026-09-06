import { exigirSessao } from '@/lib/firebase/session'
import { listarTransacoesDoMes, lerRollup } from '@/lib/firestore/repo'
import { formatCents } from '@/lib/domain/money'
import { CATEGORIAS, CATEGORIA_COR, CATEGORIA_LABEL, type Categoria } from '@/lib/domain/categories'
import { mesAnterior, mesAtual, mesLegivel, mesSeguinte, mesValido } from '@/lib/domain/month'
import { Numero } from '../numero'
import { LinhaTransacao } from './linha'
import { CategorizarPendentes } from './categorizar-pendentes'
import {
  gastoBrutoCents,
  totalNetExpenseCents,
  totalRefundCents,
} from '@/lib/firestore/rollup'

export default async function TransacoesPage({
  searchParams,
}: PageProps<'/transacoes'>) {
  const { uid, demo } = await exigirSessao()

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

  const gastoBruto = gastoBrutoCents(rollup)
  const estornos = totalRefundCents(rollup)
  const gastoLiquido = totalNetExpenseCents(rollup)
  const saldo = rollup.totalInCents - gastoLiquido

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="rotulo">Lançamentos</p>
          <h1 className="mt-2 font-display text-4xl leading-none tracking-tight sm:text-5xl">
            {mesLegivel(mes)}
          </h1>
        </div>

        {/* Navegação de mês como setas discretas: mudar de mês é o gesto mais
            repetido desta tela, e um formulário com botão "Filtrar" para isso
            seria peso demais. */}
        <nav className="flex items-center gap-1 text-sm">
          <a
            href={`/transacoes?mes=${mesAnterior(mes)}${categoria ? `&categoria=${categoria}` : ''}`}
            className="px-3 py-2 text-suave transition-colors duration-300 hover:text-texto"
            aria-label="Mês anterior"
          >
            ←
          </a>
          <a
            href={`/transacoes?mes=${mesSeguinte(mes)}${categoria ? `&categoria=${categoria}` : ''}`}
            className="px-3 py-2 text-suave transition-colors duration-300 hover:text-texto"
            aria-label="Mês seguinte"
          >
            →
          </a>
        </nav>
      </header>

      <section className="grid gap-px border-y border-linha bg-linha sm:grid-cols-2 lg:grid-cols-4">
        <Numero rotulo="Receitas" valor={formatCents(rollup.totalInCents)} entrada />
        <Numero
          rotulo="Gastos líquidos"
          valor={formatCents(-gastoLiquido)}
          detalhe={
            estornos > 0
              ? `${formatCents(-gastoBruto)} + ${formatCents(estornos)} em estornos`
              : undefined
          }
        />
        <Numero
          rotulo="Pagamentos / transf."
          valor={formatCents(rollup.totalTransferCents)}
        />
        <Numero rotulo="Resultado" valor={formatCents(saldo)} entrada={saldo >= 0} />
      </section>

      {!demo && <CategorizarPendentes key={mes} month={mes}
        quantidade={todas.filter((t) => t.category === null && !t.aiOptOut).length} />}

      {/* O filtro de categoria virou uma fileira de pílulas, e não um select
          com botão. São dez opções fixas — deixá-las visíveis é mais rápido de
          usar e mostra de cara o que existe. */}
      <nav className="flex flex-wrap gap-x-1 gap-y-2 text-sm">
        <Pilula href={`/transacoes?mes=${mes}`} ativa={categoria === null}>
          Todas
        </Pilula>
        {CATEGORIAS.map((item) => (
          <Pilula
            key={item}
            href={`/transacoes?mes=${mes}&categoria=${item}`}
            ativa={categoria === item}
            cor={CATEGORIA_COR[item]}
          >
            {CATEGORIA_LABEL[item]}
          </Pilula>
        ))}
      </nav>

      {transacoes.length === 0 ? (
        <div className="border border-dashed border-linha px-8 py-16 text-center">
          <p className="text-sm text-suave">
            {categoria
              ? `Nenhuma transação em ${CATEGORIA_LABEL[categoria]} neste mês.`
              : `Nenhuma transação em ${mesLegivel(mes)}.`}
          </p>
          {!categoria && (
            <a
              href="/importar"
              className="mt-3 inline-block text-sm text-texto underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:decoration-texto"
            >
              Importar um extrato
            </a>
          )}
        </div>
      ) : (
        <section>
          {/* Uma TABELA de verdade, e não `ul` com um cabeçalho desenhado por
              cima.
              A primeira versão do redesign trocou a tabela por lista porque dá
              mais controle visual — e o custo foi invisível na tela e enorme
              no leitor de tela: `Data / Descrição / Valor` viravam texto solto
              que não rotulava nada, e cada célula era lida sem dizer de qual
              coluna era. Com `<th scope="col">`, "14/08" é anunciado como
              *Data 14/08*.
              O visual não mudou: `table-fixed` mais três larguras reproduz o
              `grid-cols-[auto_1fr_auto]` que estava aqui. */}
          <table className="w-full table-fixed border-collapse text-left">
            <caption className="sr-only">
              Lançamentos de {mesLegivel(mes)}
              {categoria ? `, categoria ${CATEGORIA_LABEL[categoria]}` : ''}
            </caption>
            <thead>
              <tr className="border-b border-linha">
                <th scope="col" className="rotulo w-16 pb-3 font-medium">
                  Data
                </th>
                <th scope="col" className="rotulo pb-3 font-medium">
                  Descrição
                </th>
                <th scope="col" className="rotulo w-32 pb-3 text-right font-medium">
                  Valor
                </th>
              </tr>
            </thead>
            <tbody>
              {transacoes.map((t) => (
                <LinhaTransacao key={t.fingerprint} transacao={t} demo={demo} />
              ))}
            </tbody>
          </table>

          <p className="mt-6 text-xs text-fraco">
            {transacoes.length} lançamento{transacoes.length === 1 ? '' : 's'}
            {categoria ? ` em ${CATEGORIA_LABEL[categoria]}` : ''}
          </p>
        </section>
      )}
    </div>
  )
}

function Pilula({
  href,
  ativa,
  cor,
  children,
}: {
  href: string
  ativa: boolean
  cor?: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 transition-colors duration-300 ${
        ativa
          ? 'border-texto text-texto'
          : 'border-linha text-suave hover:border-linha-forte hover:text-texto'
      }`}
    >
      {cor && (
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={{ background: cor }}
        />
      )}
      {children}
    </a>
  )
}
