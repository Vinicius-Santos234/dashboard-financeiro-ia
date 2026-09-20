'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { formatCents } from '@/lib/domain/money'
import {
  displayAmountCents,
  perfilSugerido,
  FLOW_LABEL,
  type FlowSummary,
  type FlowType,
  type StatementProfile,
} from '@/lib/domain/financial-flow'
import type { InspecaoCsv, CsvMapping } from '@/lib/sources/csv'
import type { FormatoData } from '@/lib/sources/date'
import type { LinhaDescartada } from '@/lib/sources/types'

type LinhaEntendida = {
  occurredOn: string
  description: string
  amountCents: number
  flowType: FlowType
}

type Resultado = {
  importId: string
  periodo: { de: string | null; ate: string | null }
  lidas: number
  importadas: number
  duplicadas: number
  descartadas: LinhaDescartada[]
  jaImportadoAntes: boolean
  flowSummary: FlowSummary
  /**
   * Os períodos em que as transações foram gravadas — que não são o mês da
   * primeira compra quando há fechamento configurado.
   */
  periodosGravados: string[]
}

type Previsao = Pick<Resultado, 'periodo' | 'lidas' | 'descartadas' | 'flowSummary'> & {
  amostra: LinhaEntendida[]
  financialProfile: StatementProfile
  /** Dia de fechamento já configurado para o cartão, ou `null`. */
  fechamentoDoCartao: number | null
}

/**
 * A prévia **junto com os parâmetros que a produziram**.
 *
 * Sem isso, a importação enviava o estado atual da tela, que pode já não ser o
 * que gerou os números na frente da pessoa. Uma revisão externa reproduziu:
 * tela mostrando `positivo é compra`, POST indo com `positivo é crédito` —
 * uma linha de R$ 100 exibida como compra sendo gravada como estorno.
 *
 * Confirmar passa a significar *"grave exatamente isto que eu vi"*.
 */
type PreviaConfirmavel = {
  dados: Previsao
  mapping: Partial<CsvMapping>
  perfil: StatementProfile | ''
}

const FORMATOS: { valor: FormatoData; rotulo: string }[] = [
  { valor: 'dd/mm/yyyy', rotulo: 'dia/mês/ano — 31/12/2026' },
  { valor: 'mm/dd/yyyy', rotulo: 'mês/dia/ano — 12/31/2026' },
  { valor: 'yyyy-mm-dd', rotulo: 'ano-mês-dia — 2026-12-31' },
]

const ehArquivoCsv = (nome: string) => /\.(csv|txt)$/i.test(nome)

/** `2026-08-14` → `14/08`. */
const dia = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/**
 * A importação, e a etapa que ela deixou de ter.
 *
 * A versão anterior parava toda pessoa num formulário de mapeamento: quatro
 * seletores de coluna, um de formato de data, e — o pior — a pergunta *"como o
 * arquivo representa os valores?"*, com opções do tipo `Cartão Nubank —
 * positivo é compra`. Quem não trabalha com extrato não tem como responder
 * isso, e era obrigatório para passar da tela.
 *
 * Três coisas mudaram:
 *
 * 1. **O app responde sozinho.** As colunas e o formato da data já eram
 *    detectados (`inspecionar`); o que faltava era a convenção de sinal, e o
 *    arquivo a entrega — numa fatura, compra é a maioria esmagadora, então o
 *    sinal da maioria é o sinal da compra (`perfilSugerido`).
 * 2. **A conferência virou concreta.** Em vez de descrever o formato do
 *    próprio arquivo, a pessoa olha três lançamentos dela já interpretados e
 *    diz se estão certos. Reconhecer a própria compra qualquer um faz.
 * 3. **O formulário virou saída de emergência.** Ele continua inteiro, atrás
 *    de *"Algo está errado?"*, e abre sozinho quando o app de fato não sabe.
 */
export default function ImportarPage() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [arquivo, setArquivo] = useState<File | null>(null)
  const [inspecao, setInspecao] = useState<InspecaoCsv | null>(null)
  const [mapping, setMapping] = useState<Partial<CsvMapping>>({})
  const [financialProfile, setFinancialProfile] = useState<StatementProfile | ''>('')
  const [previa, setPrevia] = useState<PreviaConfirmavel | null>(null)
  const [resultado, setResultado] = useState<Resultado | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [ajustando, setAjustando] = useState(false)

  /**
   * O número da última prévia pedida.
   *
   * Cada ajuste dispara uma requisição, e elas voltam fora de ordem: a
   * resposta lenta de um perfil que a pessoa já trocou chegava depois e
   * sobrescrevia a tela. Só a resposta mais recente pode escrever.
   */
  const pedido = useRef(0)

  const ehCsv = arquivo ? ehArquivoCsv(arquivo.name) : false

  function limpar() {
    setInspecao(null)
    setMapping({})
    setFinancialProfile('')
    setPrevia(null)
    setResultado(null)
    setErro(null)
    setAjustando(false)
  }

  /**
   * O que ainda falta para o app conseguir ler o arquivo sozinho.
   *
   * Devolve frases, e não flags: elas vão para a tela do jeito que estão. Uma
   * lista vazia significa que dá para prever sem perguntar nada.
   */
  function pendencias(
    m: Partial<CsvMapping>,
    perfil: StatementProfile | '',
    insp: InspecaoCsv | null
  ): string[] {
    if (!ehCsv) return []
    const faltas: string[] = []
    if (!m.colunaData) faltas.push('qual coluna tem a data')
    if (!m.colunaDescricao) faltas.push('qual coluna tem a descrição')
    if (!m.colunaValor) faltas.push('qual coluna tem o valor')
    if (!m.formatoData && insp && !insp.formatoDataCerto) {
      faltas.push(
        'se a data é dia/mês ou mês/dia — neste arquivo todo dia e todo mês são menores que 13'
      )
    }
    if (!perfil) faltas.push('se os valores positivos são compras ou créditos')
    return faltas
  }

  function corpo(
    f: File,
    m: Partial<CsvMapping>,
    perfil: StatementProfile | ''
  ): FormData {
    const body = new FormData()
    body.set('arquivo', f)
    body.set('source', ehArquivoCsv(f.name) ? 'csv' : 'ofx')
    if (ehArquivoCsv(f.name)) {
      body.set('mapping', JSON.stringify(m))
      body.set('financialProfile', perfil)
    }
    return body
  }

  async function prever(
    f: File,
    m: Partial<CsvMapping>,
    perfil: StatementProfile | ''
  ) {
    const meu = ++pedido.current
    setErro(null)
    setOcupado(true)
    try {
      const r = await fetch('/api/imports?prever=1', {
        method: 'POST',
        body: corpo(f, m, perfil),
      })
      const json = await r.json()

      // Chegou tarde: a pessoa já mexeu de novo, e o que está na tela pertence
      // a outro pedido. Escrever aqui mostraria números de um ajuste que ela
      // desfez.
      if (meu !== pedido.current) return

      if (!r.ok) {
        setErro(json.erro ?? 'Não foi possível ler o arquivo.')
        setAjustando(true)
        return
      }
      // A prévia guarda o mapeamento e o perfil que a produziram, e é com eles
      // que a importação vai rodar.
      setPrevia({ dados: json, mapping: m, perfil })
    } catch {
      if (meu !== pedido.current) return
      setErro('Não foi possível ler o arquivo. Verifique a conexão e tente novamente.')
    } finally {
      if (meu === pedido.current) setOcupado(false)
    }
  }

  async function escolher(f: File | null) {
    limpar()
    setArquivo(f)
    if (!f) return

    // OFX declara o próprio formato: não há o que mapear nem o que perguntar.
    if (!ehArquivoCsv(f.name)) {
      await prever(f, {}, '')
      return
    }

    setOcupado(true)
    let insp: InspecaoCsv
    try {
      const body = new FormData()
      body.set('arquivo', f)
      body.set('source', 'csv')
      const r = await fetch('/api/imports?inspecionar=1', { method: 'POST', body })
      const json = await r.json()
      if (!r.ok) {
        setErro(json.erro ?? 'Não foi possível ler o arquivo.')
        return
      }
      insp = json.inspecao
      setInspecao(insp)
    } catch {
      setErro('Não foi possível ler o arquivo. Verifique a conexão e tente novamente.')
      return
    } finally {
      setOcupado(false)
    }

    const sugerido = insp.sugestao
    // O palpite do próprio arquivo sobre a convenção de sinal. `null` quando
    // ele não permite afirmar — e aí a pergunta sobe para a pessoa, em vez de
    // o app chutar e inverter todos os números do mês.
    const perfil = perfilSugerido(insp.sinais) ?? ''

    setMapping(sugerido)
    setFinancialProfile(perfil)

    if (pendencias(sugerido, perfil, insp).length > 0) {
      setAjustando(true)
      return
    }
    await prever(f, sugerido, perfil)
  }

  /** Reaplica a prévia depois de um ajuste manual. */
  async function reconferir(
    m: Partial<CsvMapping> = mapping,
    perfil: StatementProfile | '' = financialProfile
  ) {
    if (!arquivo) return
    setPrevia(null)
    if (pendencias(m, perfil, inspecao).length > 0) return
    await prever(arquivo, m, perfil)
  }

  function ajustarMapping(patch: Partial<CsvMapping>) {
    const novo = { ...mapping, ...patch }
    setMapping(novo)
    void reconferir(novo, financialProfile)
  }

  function ajustarPerfil(perfil: StatementProfile) {
    setFinancialProfile(perfil)
    void reconferir(mapping, perfil)
  }

  async function importar() {
    // Os parâmetros vêm da PRÉVIA, e não do estado atual da tela. É a
    // diferença entre "grave o que eu vi" e "grave o que estiver no formulário
    // no instante do clique" — que podem divergir quando uma resposta chega
    // tarde ou a pessoa mexe num ajuste sem reconferir.
    if (!arquivo || !previa) return
    setErro(null)
    setOcupado(true)
    try {
      const r = await fetch('/api/imports', {
        method: 'POST',
        body: corpo(arquivo, previa.mapping, previa.perfil),
      })
      const json = await r.json()
      if (!r.ok) {
        setErro(json.erro ?? 'Falha ao importar.')
        return
      }
      setResultado(json)
      // A revisão e o opt-out acontecem antes do primeiro envio à IA.
      router.refresh()
    } catch {
      setErro(
        'Não foi possível confirmar a importação. Verifique as transações antes de tentar novamente.'
      )
    } finally {
      setOcupado(false)
    }
  }

  const faltas = pendencias(mapping, financialProfile, inspecao)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-4xl leading-none tracking-tight">
          Importar fatura
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-suave">
          Exporte a fatura do seu cartão em OFX ou CSV e envie aqui. O arquivo não
          é guardado — é lido e descartado; só as transações ficam.
        </p>
      </div>

      <div className="rounded-md border border-linha p-6">
        <input
          ref={inputRef}
          type="file"
          accept=".ofx,.qfx,.csv,.txt"
          disabled={ocupado}
          onChange={(e) => escolher(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-suave file:mr-4 file:cursor-pointer file:rounded-md file:border file:border-linha-forte file:bg-transparent file:px-4 file:py-2 file:text-sm file:text-texto hover:file:border-texto"
        />
        {arquivo && (
          <p className="mt-3 text-sm text-suave">
            {arquivo.name} · {(arquivo.size / 1024).toFixed(1)} KB
          </p>
        )}
      </div>

      {ocupado && !previa && !resultado && (
        <p className="text-sm text-suave">Lendo o arquivo…</p>
      )}

      {erro && (
        <p role="alert" className="text-sm" style={{ color: 'var(--alarme)' }}>
          {erro}
        </p>
      )}

      {/* O que o app não conseguiu deduzir, dito em uma frase por item. Só
          aparece quando existe: na maioria dos arquivos, não existe. */}
      {arquivo && !resultado && faltas.length > 0 && (
        <div className="rounded-md border border-linha-forte p-6">
          <h2 className="text-sm font-medium">Preciso de uma informação</h2>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-suave">
            {faltas.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-suave">Responda logo abaixo.</p>
        </div>
      )}

      {previa && !resultado && (
        <Conferencia
          p={previa.dados}
          onImportar={importar}
          ocupado={ocupado}
          ajustando={ajustando}
          onAjustar={() => setAjustando((v) => !v)}
        />
      )}

      {arquivo && ehCsv && inspecao && !resultado && (ajustando || faltas.length > 0) && (
        <Ajustes
          inspecao={inspecao}
          mapping={mapping}
          perfil={financialProfile}
          onMapping={ajustarMapping}
          onPerfil={ajustarPerfil}
        />
      )}

      {resultado && (
        <Resumo
          r={resultado}
          onNovo={() => {
            limpar()
            setArquivo(null)
            if (inputRef.current) inputRef.current.value = ''
          }}
        />
      )}
    </div>
  )
}

/**
 * A conferência que substituiu o formulário.
 *
 * Mostra três lançamentos do próprio arquivo **já interpretados** — data,
 * descrição e o tipo que cada um recebeu. É a pergunta *"entendi certo?"*
 * feita de um jeito que não exige saber nada sobre o formato do arquivo.
 */
function Conferencia({
  p,
  onImportar,
  ocupado,
  ajustando,
  onAjustar,
}: {
  p: Previsao
  onImportar: () => void
  ocupado: boolean
  ajustando: boolean
  onAjustar: () => void
}) {
  const s = p.flowSummary

  return (
    <div className="rounded-md border border-linha-forte p-6">
      <h2 className="font-display text-2xl">Confira se entendi</h2>
      <p className="mt-1 text-sm text-suave">
        {p.lidas} lançamento{p.lidas === 1 ? '' : 's'}
        {p.periodo.de && ` · ${dia(p.periodo.de)} a ${dia(p.periodo.ate ?? p.periodo.de)}`}
      </p>

      {p.amostra.length > 0 && (
        <table className="mt-5 w-full text-left text-sm">
          <caption className="sr-only">
            As primeiras linhas do arquivo, como o app as interpretou
          </caption>
          <thead>
            <tr className="border-b border-linha">
              <th scope="col" className="rotulo w-14 pb-2 font-medium">
                Data
              </th>
              <th scope="col" className="rotulo pb-2 font-medium">
                Descrição
              </th>
              <th scope="col" className="rotulo w-32 pb-2 font-medium">
                É o quê
              </th>
              <th scope="col" className="rotulo w-28 pb-2 text-right font-medium">
                Valor
              </th>
            </tr>
          </thead>
          <tbody>
            {p.amostra.map((linha, i) => {
              const exibido = displayAmountCents(linha)
              return (
                <tr key={i} className="border-b border-linha last:border-0">
                  <td className="valor py-2.5 text-sm text-fraco">
                    {dia(linha.occurredOn)}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="block truncate">{linha.description}</span>
                  </td>
                  <td className="py-2.5 text-sm text-suave">
                    {FLOW_LABEL[linha.flowType]}
                  </td>
                  <td
                    className="valor py-2.5 text-right"
                    style={
                      linha.flowType === 'expense'
                        ? undefined
                        : { color: 'var(--entrada)' }
                    }
                  >
                    {formatCents(exibido)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <p className="mt-4 text-sm leading-relaxed text-suave">
        {p.amostra.length > 0 && p.lidas > p.amostra.length
          ? `Estas são as ${p.amostra.length} primeiras linhas. `
          : ''}
        No total: <strong className="text-texto">{s.expenseCount} compras</strong>{' '}
        somando {formatCents(s.grossExpenseCents)}
        {s.refundCount > 0 &&
          `, ${s.refundCount} estorno${s.refundCount === 1 ? '' : 's'} de ${formatCents(s.refundCents)}`}
        {s.transferCount > 0 &&
          `, ${s.transferCount} pagamento${s.transferCount === 1 ? '' : 's'} de ${formatCents(s.transferCents)}`}
        {s.incomeCount > 0 &&
          `, ${s.incomeCount} entrada${s.incomeCount === 1 ? '' : 's'} de ${formatCents(s.incomeCents)}`}
        .
      </p>

      {p.descartadas.length > 0 && (
        <p className="mt-2 text-sm text-suave">
          {p.descartadas.length} linha(s) não puderam ser lidas e ficarão de fora.
        </p>
      )}

      <AvisoDePeriodo p={p} />

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <Button onClick={onImportar} disabled={ocupado}>
          {ocupado ? 'Importando…' : `Importar ${p.lidas} lançamentos`}
        </Button>
        <button
          type="button"
          onClick={onAjustar}
          aria-expanded={ajustando}
          className="text-sm text-fraco underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-texto"
        >
          {ajustando ? 'Fechar ajustes' : 'Algo está errado?'}
        </button>
      </div>
    </div>
  )
}

/**
 * O aviso que faltava: **esta fatura vai aparecer dividida**.
 *
 * Uma fatura de cartão atravessa dois meses civis — a que fecha em 13/09
 * cobre compras de 14/08 a 13/09. Sem dia de fechamento configurado, o app
 * agrupa pelo calendário, então importar a fatura de setembro **engorda
 * agosto**. Isso está certo e é o que a spec 003 §5 D2 descreve; o que estava
 * errado era não dizer.
 *
 * O aviso só aparece quando as três condições valem juntas: é cartão, o
 * arquivo atravessa mais de um mês, e não há fechamento configurado. Com
 * fechamento, o agrupamento já é por fatura e não há o que avisar.
 */
function AvisoDePeriodo({ p }: { p: Previsao }) {
  if (p.financialProfile === 'bank_account') return null
  if (p.fechamentoDoCartao !== null) return null
  if (!p.periodo.de || !p.periodo.ate) return null

  const mesDe = p.periodo.de.slice(0, 7)
  const mesAte = p.periodo.ate.slice(0, 7)
  if (mesDe === mesAte) return null

  return (
    <div className="mt-4 rounded-md border border-linha-forte p-4">
      <p className="text-sm leading-relaxed">
        <strong>Esta fatura vai aparecer dividida em dois meses.</strong> As
        compras vão de {dia(p.periodo.de)} a {dia(p.periodo.ate)}, e sem o dia
        de fechamento do seu cartão o app agrupa pelo mês do calendário — então
        parte dela vai contar em {mesLegivelCurto(mesDe)} e parte em{' '}
        {mesLegivelCurto(mesAte)}.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-suave">
        Para cada fatura contar como uma só, informe o dia em que seu cartão
        fecha — está no nome do arquivo que o banco gera e na própria fatura.
      </p>
      <a
        href="/conta"
        className="mt-3 inline-block text-sm text-texto underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:decoration-texto"
      >
        Configurar o fechamento em Conta
      </a>
    </div>
  )
}

/** `2026-08` → `agosto`. */
function mesLegivelCurto(mes: string): string {
  const [ano, numero] = mes.split('-').map(Number)
  return new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(
    new Date(Date.UTC(ano, numero - 1, 15))
  )
}

/**
 * A saída de emergência: o formulário inteiro, agora opcional.
 *
 * Continua podendo tudo que podia — inclusive importar extrato de conta
 * corrente, que a spec 003 §4 manda **demover e não deletar**. O que mudou é
 * que ele deixou de ser o pedágio de toda importação.
 */
function Ajustes({
  inspecao,
  mapping,
  perfil,
  onMapping,
  onPerfil,
}: {
  inspecao: InspecaoCsv
  mapping: Partial<CsvMapping>
  perfil: StatementProfile | ''
  onMapping: (patch: Partial<CsvMapping>) => void
  onPerfil: (p: StatementProfile) => void
}) {
  const ehConta = perfil === 'bank_account'

  return (
    <div className="flex flex-col gap-6 rounded-md border border-linha p-6">
      <div>
        <p className="rotulo">O sinal dos valores</p>
        {ehConta ? (
          <p className="mt-2 text-sm text-suave">
            Num extrato de conta, entradas são positivas e saídas negativas.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm">Nesta fatura, um valor positivo é:</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Opcao
                ativa={perfil === 'credit_card_positive_expenses'}
                onClick={() => onPerfil('credit_card_positive_expenses')}
              >
                Uma compra
              </Opcao>
              <Opcao
                ativa={perfil === 'credit_card_negative_expenses'}
                onClick={() => onPerfil('credit_card_negative_expenses')}
              >
                Um crédito ou pagamento
              </Opcao>
            </div>
            <p className="mt-2 text-xs text-fraco">
              Se as compras apareceram como entrada na conferência acima, é esta
              opção que está trocada.
            </p>
          </>
        )}
      </div>

      <div className="border-t border-linha pt-5">
        <p className="rotulo">Formato da data</p>
        <select
          value={mapping.formatoData ?? ''}
          onChange={(e) =>
            onMapping({ formatoData: (e.target.value || undefined) as FormatoData })
          }
          className="campo mt-2 px-3 py-2 text-sm"
        >
          <option value="">Detectar automaticamente</option>
          {FORMATOS.map((f) => (
            <option key={f.valor} value={f.valor}>
              {f.rotulo}
            </option>
          ))}
        </select>
        {!inspecao.formatoDataCerto && !mapping.formatoData && (
          // A detecção só desempata dd/mm de mm/dd quando alguma data tem dia
          // > 12. Quando não tem, adivinhar trocaria dia por mês em silêncio —
          // então a escolha sobe para quem sabe.
          <p className="mt-2 text-xs" style={{ color: 'var(--alarme)' }}>
            Neste arquivo todo dia e todo mês são menores que 13, então não deu
            para deduzir. Escolha acima.
          </p>
        )}
      </div>

      <div className="border-t border-linha pt-5">
        <p className="rotulo">As colunas do arquivo</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Seletor
            rotulo="Data"
            colunas={inspecao.colunas}
            valor={mapping.colunaData}
            onChange={(v) => onMapping({ colunaData: v })}
          />
          <Seletor
            rotulo="Descrição"
            colunas={inspecao.colunas}
            valor={mapping.colunaDescricao}
            onChange={(v) => onMapping({ colunaDescricao: v })}
          />
          <Seletor
            rotulo="Valor"
            colunas={inspecao.colunas}
            valor={mapping.colunaValor}
            onChange={(v) => onMapping({ colunaValor: v })}
          />
          <Seletor
            rotulo="Saídas, se estiverem em coluna separada"
            colunas={inspecao.colunas}
            valor={mapping.colunaValorSaida}
            opcional
            onChange={(v) => onMapping({ colunaValorSaida: v || undefined })}
          />
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-suave">
            Ver as primeiras linhas do arquivo, como estão nele
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-suave">
                <tr>
                  {inspecao.colunas.map((c) => (
                    <th key={c} className="px-2 py-1 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inspecao.amostra.map((linha, i) => (
                  <tr key={i} className="border-t border-linha">
                    {inspecao.colunas.map((c) => (
                      <td key={c} className="px-2 py-1">
                        {linha[c]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      {/* Conta corrente sai do caminho principal e vira isto: uma linha, no
          fim dos ajustes. O produto é um controlador de fatura (003 D1), e
          oferecer os dois como iguais na primeira tela era metade da confusão
          que esta reescrita existe para desfazer. */}
      <div className="border-t border-linha pt-5">
        <p className="rotulo">Não é uma fatura?</p>
        <label className="mt-2 flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={ehConta}
            onChange={(e) =>
              onPerfil(
                e.target.checked ? 'bank_account' : 'credit_card_negative_expenses'
              )
            }
            className="mt-0.5"
          />
          <span className="text-suave">
            Este arquivo é um <strong className="text-texto">extrato de conta
            corrente</strong>, e não a fatura de um cartão. O app aceita os dois,
            e a tela se ajusta ao que você importar.
          </span>
        </label>
      </div>
    </div>
  )
}

function Opcao({
  ativa,
  onClick,
  children,
}: {
  ativa: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ativa}
      className={`rounded-full border px-4 py-2 text-sm transition-colors duration-300 ${
        ativa
          ? 'border-texto text-texto'
          : 'border-linha text-suave hover:border-linha-forte hover:text-texto'
      }`}
    >
      {children}
    </button>
  )
}

function Seletor({
  rotulo,
  colunas,
  valor,
  onChange,
  opcional,
}: {
  rotulo: string
  colunas: string[]
  valor: string | undefined
  onChange: (v: string) => void
  opcional?: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-suave">{rotulo}</span>
      <select
        value={valor ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="campo px-3 py-2 text-sm"
      >
        <option value="">{opcional ? 'Nenhuma' : 'Escolha…'}</option>
        {colunas.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  )
}

function Resumo({ r, onNovo }: { r: Resultado; onNovo: () => void }) {
  return (
    <div className="rounded-md border border-linha p-6">
      <h2 className="font-display text-2xl">Importação concluída</h2>

      {r.jaImportadoAntes && (
        <p className="mt-3 rounded-md border border-linha-forte px-3 py-2 text-sm text-suave">
          Este mesmo arquivo já tinha sido importado antes. As transações
          repetidas foram reconhecidas e não entraram de novo.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Item rotulo="Lidas" valor={r.lidas} />
        <Item rotulo="Importadas" valor={r.importadas} />
        <Item rotulo="Já existiam" valor={r.duplicadas} />
        <Item rotulo="Descartadas" valor={r.descartadas.length} />
      </dl>

      {r.periodo.de && (
        <p className="mt-3 text-sm text-suave">
          Período: {r.periodo.de} a {r.periodo.ate}
        </p>
      )}

      {r.descartadas.length > 0 && (
        // Linha descartada nunca some calada: sem esta lista, o total do
        // dashboard divergiria do extrato sem nenhuma pista de onde.
        <details className="mt-4" open>
          <summary className="cursor-pointer text-sm font-medium">
            {r.descartadas.length} linha(s) não puderam ser lidas
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-suave">
            {r.descartadas.map((d, i) => (
              <li key={i} className="border-l-2 border-linha-forte pl-2">
                <span className="font-medium">Linha {d.linha}</span> — {d.motivo}
                <br />
                <span className="text-suave">{d.conteudo}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-4 text-sm leading-relaxed text-suave">
        Nenhuma descrição foi enviada à IA nesta importação. Revise as transações,
        bloqueie as que preferir e depois categorize as pendências de cada mês.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <Button onClick={onNovo}>Importar outro</Button>
        {/* O período GRAVADO, e não o mês da primeira compra: com fechamento
            configurado, uma compra de 28/09 vai para a fatura de outubro, e o
            link mandava a pessoa para setembro — onde não havia nada do que
            ela acabara de importar. */}
        <a
          href={`/transacoes${r.periodosGravados?.[0] ? `?mes=${r.periodosGravados[0]}` : ''}`}
          className="inline-flex items-center text-sm text-suave underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-texto"
        >
          {r.periodosGravados?.length > 1
            ? `Revisar e categorizar (${r.periodosGravados.length} faturas)`
            : 'Revisar e categorizar'}
        </a>
      </div>
    </div>
  )
}

function Item({ rotulo, valor }: { rotulo: string; valor: string | number }) {
  return (
    <div>
      <dt className="text-suave">{rotulo}</dt>
      <dd className="valor text-lg font-semibold">{valor}</dd>
    </div>
  )
}
