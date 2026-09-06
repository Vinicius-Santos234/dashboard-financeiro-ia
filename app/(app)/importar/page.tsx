'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
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
 categorizacao?: { total: number; porIa: number; porRegra: number; model: string }
 aviso?: string
}

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
 const [resultado, setResultado] = useState<Resultado | null>(null)
 const [erro, setErro] = useState<string | null>(null)
 const [ocupado, setOcupado] = useState(false)

 const ehCsv = arquivo ? /\.(csv|txt)$/i.test(arquivo.name) : false

 function limpar() {
 setInspecao(null)
 setMapping({})
 setResultado(null)
 setErro(null)
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
 } finally {
 setOcupado(false)
 }
 }

 async function importar() {
 if (!arquivo) return
 setErro(null)
 setOcupado(true)

 try {
 const body = new FormData()
 body.set('arquivo', arquivo)
 body.set('source', ehCsv ? 'csv' : 'ofx')
 if (ehCsv) body.set('mapping', JSON.stringify(mapping))

 const r = await fetch('/api/imports', { method: 'POST', body })
 const json = await r.json()

 if (!r.ok) {
 setErro(json.erro ?? 'Falha ao importar.')
 return
 }

 setResultado(json)

 // Importar é durável mesmo se o provedor estiver indisponível. A tela
 // deixa isso explícito e a categorização pode ser tentada novamente.
 const categoria = await fetch('/api/categorize', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ importId: json.importId }),
 })
 const categoriaJson = await categoria.json()
 setResultado(
 categoria.ok
 ? { ...json, categorizacao: categoriaJson }
 : { ...json, aviso: categoriaJson.erro ?? 'Categorização pendente.' }
 )
 router.refresh()
 } finally {
 setOcupado(false)
 }
 }

 const faltaMapear =
 ehCsv &&
 (!mapping.colunaData || !mapping.colunaDescricao || !mapping.colunaValor)

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

 <div className="mt-4 grid gap-4 sm:grid-cols-2">
 <Seletor
 rotulo="Data"
 colunas={inspecao.colunas}
 valor={mapping.colunaData}
 onChange={(v) => setMapping({ ...mapping, colunaData: v })}
 />
 <Seletor
 rotulo="Descrição"
 colunas={inspecao.colunas}
 valor={mapping.colunaDescricao}
 onChange={(v) => setMapping({ ...mapping, colunaDescricao: v })}
 />
 <Seletor
 rotulo="Valor (ou entradas)"
 colunas={inspecao.colunas}
 valor={mapping.colunaValor}
 onChange={(v) => setMapping({ ...mapping, colunaValor: v })}
 />
 <Seletor
 rotulo="Saídas (se houver coluna separada)"
 colunas={inspecao.colunas}
 valor={mapping.colunaValorSaida}
 opcional
 onChange={(v) =>
 setMapping({ ...mapping, colunaValorSaida: v || undefined })
 }
 />
 </div>

 <label className="mt-4 flex flex-col gap-1.5 text-sm">
 <span className="font-medium">Formato da data</span>
 <select
 value={mapping.formatoData ?? ''}
 onChange={(e) =>
 setMapping({
 ...mapping,
 formatoData: (e.target.value || undefined) as FormatoData,
 })
 }
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

 {arquivo && !resultado && (
 <div>
 <Button onClick={importar} disabled={ocupado || faltaMapear}>
 {ocupado ? 'Processando…' : 'Importar'}
 </Button>
 {faltaMapear && (
 <p className="mt-2 text-sm text-suave">
 Escolha as colunas de data, descrição e valor.
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

 {r.categorizacao && (
 <p className="mt-4 border-l-2 px-3 py-2 text-sm text-suave" style={{ borderColor: 'var(--entrada)' }}>
 {r.categorizacao.total} transação(ões) categorizada(s):{' '}
 {r.categorizacao.porRegra} por regra e {r.categorizacao.porIa} por IA.
 </p>
 )}

 {r.aviso && (
 <p role="alert" className="mt-4 rounded-md border border-linha-forte px-3 py-2 text-sm text-suave">
 {r.aviso}
 </p>
 )}

 <div className="mt-5 flex gap-3">
 <Button onClick={onNovo}>Importar outro</Button>
 <a
 href="/transacoes"
 className="inline-flex items-center text-sm text-suave underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-texto"
 >
 Ver transações
 </a>
 </div>
 </div>
 )
}

function Item({ rotulo, valor }: { rotulo: string; valor: number }) {
 return (
 <div>
 <dt className="text-suave">{rotulo}</dt>
 <dd className="text-lg font-semibold tabular-nums">{valor}</dd>
 </div>
 )
}
