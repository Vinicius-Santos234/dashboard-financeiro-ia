'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { formatCents } from '@/lib/domain/money'
import type {
 FlowSummary,
 StatementProfile,
} from '@/lib/domain/financial-flow'
import type { InspecaoCsv, CsvMapping } from '@/lib/sources/csv'
import type { FormatoData } from '@/lib/sources/date'
import type { LinhaDescartada } from '@/lib/sources/types'

type Resultado = {
 importId: string
 periodo: { de: string | null; ate: string | null }
 lidas: number
 importadas: number
 duplicadas: number
 descartadas: LinhaDescartada[]
 jaImportadoAntes: boolean
 flowSummary: FlowSummary
}

type Previsao = Pick<Resultado, 'periodo' | 'lidas' | 'descartadas' | 'flowSummary'>

const FORMATOS: { valor: FormatoData; rotulo: string }[] = [
 { valor: 'dd/mm/yyyy', rotulo: 'dia/mês/ano (31/12/2026)' },
 { valor: 'mm/dd/yyyy', rotulo: 'mês/dia/ano (12/31/2026)' },
 { valor: 'yyyy-mm-dd', rotulo: 'ano-mês-dia (2026-12-31)' },
]

export default function ImportarPage() {
 const router = useRouter()
 const inputRef = useRef<HTMLInputElement>(null)

 const [arquivo, setArquivo] = useState<File | null>(null)
 const [inspecao, setInspecao] = useState<InspecaoCsv | null>(null)
 const [mapping, setMapping] = useState<Partial<CsvMapping>>({})
 const [financialProfile, setFinancialProfile] = useState<StatementProfile | ''>('')
 const [previsao, setPrevisao] = useState<Previsao | null>(null)
 const [resultado, setResultado] = useState<Resultado | null>(null)
 const [erro, setErro] = useState<string | null>(null)
 const [ocupado, setOcupado] = useState(false)

 const ehCsv = arquivo ? /\.(csv|txt)$/i.test(arquivo.name) : false

 function limpar() {
 setInspecao(null)
 setMapping({})
 setFinancialProfile('')
 setPrevisao(null)
 setResultado(null)
 setErro(null)
 }

 function bodyDaImportacao(): FormData | null {
 if (!arquivo) return null
 const body = new FormData()
 body.set('arquivo', arquivo)
 body.set('source', ehCsv ? 'csv' : 'ofx')
 if (ehCsv) {
 body.set('mapping', JSON.stringify(mapping))
 body.set('financialProfile', financialProfile)
 }
 return body
 }

 async function prever() {
 const body = bodyDaImportacao()
 if (!body) return
 setErro(null)
 setOcupado(true)
 try {
 const r = await fetch('/api/imports?prever=1', { method: 'POST', body })
 const json = await r.json()
 if (!r.ok) {
 setErro(json.erro ?? 'Não foi possível montar a prévia.')
 return
 }
 setPrevisao(json)
 } catch {
 setErro('Não foi possível montar a prévia. Verifique a conexão e tente novamente.')
 } finally {
 setOcupado(false)
 }
 }

 async function escolher(f: File | null) {
 limpar()
 setArquivo(f)
 if (!f) return

 // CSV precisa do mapeamento antes de importar; OFX vai direto.
 if (!/\.(csv|txt)$/i.test(f.name)) return

 setOcupado(true)
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
 setInspecao(json.inspecao)
 setMapping(json.inspecao.sugestao)
 } catch {
 setErro('Não foi possível ler o arquivo. Verifique a conexão e tente novamente.')
 } finally {
 setOcupado(false)
 }
 }

 async function importar() {
 if (!arquivo) return
 setErro(null)
 setOcupado(true)

 try {
 const body = bodyDaImportacao()
 if (!body) return

 const r = await fetch('/api/imports', { method: 'POST', body })
 const json = await r.json()

 if (!r.ok) {
 setErro(json.erro ?? 'Falha ao importar.')
 return
 }

 setResultado(json)

 // A revisão e o opt-out acontecem antes do primeiro envio à IA.
 router.refresh()
 } catch {
 setErro('Não foi possível confirmar a importação. Verifique as transações antes de tentar novamente.')
 } finally {
 setOcupado(false)
 }
 }

 const faltaMapear =
 ehCsv &&
 (!mapping.colunaData ||
  !mapping.colunaDescricao ||
  !mapping.colunaValor ||
  !financialProfile)

 return (
 <div className="flex flex-col gap-6">
 <div>
 <h1 className="font-display text-4xl leading-none tracking-tight">Importar extrato</h1>
 <p className="mt-1 text-sm text-suave">
 Exporte o extrato do seu banco em OFX ou CSV e envie aqui. O arquivo
 não é guardado — é lido e descartado; só as transações ficam.
 </p>
 </div>

 <div className="rounded-md border border-linha p-6 ">
 <input
 ref={inputRef}
 type="file"
 accept=".ofx,.qfx,.csv,.txt"
 disabled={ocupado}
 onChange={(e) => escolher(e.target.files?.[0] ?? null)}
 className="block w-full text-sm text-suave file:mr-4 file:cursor-pointer file:border file:border-linha-forte file:bg-transparent file:px-4 file:py-2 file:text-sm file:text-texto hover:file:border-texto"
 />

 {arquivo && (
 <p className="mt-3 text-sm text-suave">
 {arquivo.name} · {(arquivo.size / 1024).toFixed(1)} KB
 </p>
 )}
 </div>

 {inspecao && (
 <div className="rounded-md border border-linha p-6 ">
 <h2 className="text-sm font-medium">Mapeamento das colunas</h2>
 <p className="mt-1 text-sm text-suave">
 Cada banco nomeia as colunas de um jeito. Confira o que foi
 detectado — {inspecao.totalLinhas} linhas encontradas.
 </p>

 <label className="mt-4 flex flex-col gap-1.5 text-sm">
 <span className="font-medium">Como o arquivo representa os valores?</span>
 <select
 value={financialProfile}
 onChange={(e) => {
 setFinancialProfile(e.target.value as StatementProfile | '')
 setPrevisao(null)
 }}
 className="rounded-md border border-linha-forte px-3 py-2 text-sm"
 >
 <option value="">Escolha…</option>
 <option value="bank_account">Conta bancária — positivo é entrada</option>
 <option value="credit_card_positive_expenses">
 Cartão Nubank — positivo é compra
 </option>
 <option value="credit_card_negative_expenses">
 Cartão — negativo é compra
 </option>
 </select>
 <span className="text-xs text-fraco">
 Pagamentos de fatura serão identificados como transferências e não entrarão
 em gastos ou receitas.
 </span>
 </label>

 <div className="mt-4 grid gap-4 sm:grid-cols-2">
 <Seletor
 rotulo="Data"
 colunas={inspecao.colunas}
 valor={mapping.colunaData}
 onChange={(v) => { setMapping({ ...mapping, colunaData: v }); setPrevisao(null) }}
 />
 <Seletor
 rotulo="Descrição"
 colunas={inspecao.colunas}
 valor={mapping.colunaDescricao}
 onChange={(v) => { setMapping({ ...mapping, colunaDescricao: v }); setPrevisao(null) }}
 />
 <Seletor
 rotulo="Valor (ou entradas)"
 colunas={inspecao.colunas}
 valor={mapping.colunaValor}
 onChange={(v) => { setMapping({ ...mapping, colunaValor: v }); setPrevisao(null) }}
 />
 <Seletor
 rotulo="Saídas (se houver coluna separada)"
 colunas={inspecao.colunas}
 valor={mapping.colunaValorSaida}
 opcional
 onChange={(v) => {
 setMapping({ ...mapping, colunaValorSaida: v || undefined })
 setPrevisao(null)
 }}
 />
 </div>

 <label className="mt-4 flex flex-col gap-1.5 text-sm">
 <span className="font-medium">Formato da data</span>
 <select
 value={mapping.formatoData ?? ''}
 onChange={(e) => {
 setMapping({
 ...mapping,
 formatoData: (e.target.value || undefined) as FormatoData,
 })
 setPrevisao(null)
 }}
 className="rounded-md border border-linha-forte px-3 py-2 text-sm"
 >
 <option value="">Detectar automaticamente</option>
 {FORMATOS.map((f) => (
 <option key={f.valor} value={f.valor}>
 {f.rotulo}
 </option>
 ))}
 </select>
 </label>

 {!inspecao.formatoDataCerto && (
 // A detecção só desempata dd/mm de mm/dd quando alguma data tem
 // dia > 12. Quando não tem, adivinhar trocaria dia por mês em
 // silêncio — então a escolha sobe para quem sabe.
 <p className="mt-2 rounded-md border border-linha-forte px-3 py-2 text-sm text-suave">
 Não deu para deduzir o formato das datas: neste arquivo todo dia e
 todo mês são menores que 13. Escolha acima.
 </p>
 )}

 <details className="mt-4">
 <summary className="cursor-pointer text-sm text-suave">
 Ver as primeiras linhas
 </summary>
 <div className="mt-2 overflow-x-auto">
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
 )}

 {erro && (
 <p
 role="alert"
 className="rounded-md px-3 py-2 text-sm"
 >
 {erro}
 </p>
 )}

 {previsao && !resultado && <Previa r={previsao} />}

 {arquivo && !resultado && (
 <div className="flex flex-wrap items-center gap-3">
 <Button
 onClick={previsao ? importar : prever}
 disabled={ocupado || faltaMapear}
 >
 {ocupado
 ? 'Processando…'
 : previsao
   ? 'Confirmar importação'
   : 'Revisar importação'}
 </Button>
 {previsao && (
 <button
 type="button"
 onClick={() => setPrevisao(null)}
 className="text-sm text-suave underline decoration-linha-forte underline-offset-4"
 >
 Alterar opções
 </button>
 )}
 {faltaMapear && (
 <p className="mt-2 text-sm text-suave">
 Escolha as colunas e o tipo de extrato.
 </p>
 )}
 </div>
 )}

 {resultado && <Resumo r={resultado} onNovo={() => {
 limpar()
 setArquivo(null)
 if (inputRef.current) inputRef.current.value = ''
 }} />}
 </div>
 )
}

function Previa({ r }: { r: Previsao }) {
 const s = r.flowSummary
 return (
 <div className="rounded-md border border-linha-forte p-6">
 <h2 className="text-sm font-medium">Confira antes de importar</h2>
 <p className="mt-1 text-sm text-suave">
 {r.lidas} lançamentos · {r.periodo.de} a {r.periodo.ate}
 </p>
 <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
 <Item rotulo={`Compras (${s.expenseCount})`} valor={formatCents(s.grossExpenseCents)} />
 <Item rotulo={`Receitas (${s.incomeCount})`} valor={formatCents(s.incomeCents)} />
 <Item rotulo={`Pagamentos/transf. (${s.transferCount})`} valor={formatCents(s.transferCents)} />
 <Item rotulo={`Créditos/estornos (${s.refundCount})`} valor={formatCents(s.refundCents)} />
 </dl>
 <p className="mt-4 text-sm">
 Gasto líquido previsto: <strong>{formatCents(s.netExpenseCents)}</strong>
 </p>
 {r.descartadas.length > 0 && (
 <p className="mt-2 text-sm text-suave">
 {r.descartadas.length} linha(s) não serão importadas.
 </p>
 )}
 </div>
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
 <span className="font-medium">{rotulo}</span>
 <select
 value={valor ?? ''}
 onChange={(e) => onChange(e.target.value)}
 className="rounded-md border border-linha-forte px-3 py-2 text-sm"
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
 <div className="rounded-md border border-linha p-6 ">
 <h2 className="text-sm font-medium">Importação concluída</h2>

 {r.jaImportadoAntes && (
 <p className="mt-2 rounded-md border border-linha-forte px-3 py-2 text-sm text-suave">
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
 <li key={i} className="border-l-2 border-linha-forte pl-2 ">
 <span className="font-medium">Linha {d.linha}</span> — {d.motivo}
 <br />
 <span className="text-suave">{d.conteudo}</span>
 </li>
 ))}
 </ul>
 </details>
 )}

 <p className="mt-4 text-sm text-suave">
 Nenhuma descrição foi enviada à IA nesta importação. Revise as transações,
 bloqueie as que preferir e depois categorize as pendências de cada mês.
 </p>

 <div className="mt-5 flex gap-3">
 <Button onClick={onNovo}>Importar outro</Button>
 <a
 href={`/transacoes${r.periodo.de ? `?mes=${r.periodo.de.slice(0, 7)}` : ''}`}
 className="inline-flex items-center text-sm text-suave underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-texto"
 >
 Revisar e categorizar
 </a>
 </div>
 </div>
 )
}

function Item({ rotulo, valor }: { rotulo: string; valor: string | number }) {
 return (
 <div>
 <dt className="text-suave">{rotulo}</dt>
 <dd className="text-lg font-semibold tabular-nums">{valor}</dd>
 </div>
 )
}
