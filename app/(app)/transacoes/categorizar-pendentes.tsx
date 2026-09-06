'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function CategorizarPendentes({ month, quantidade }: { month: string; quantidade: number }) {
  const router = useRouter()
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [mensagem, setMensagem] = useState<string | null>(null)

  async function categorizar() {
    setOcupado(true)
    setErro(null)
    setMensagem(null)
    try {
      const resposta = await fetch('/api/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, confirmarEnvio: true }),
      })
      const json = await resposta.json()
      if (!resposta.ok) {
        setErro(json.erro ?? 'Não foi possível categorizar. Tente novamente.')
      } else {
        setMensagem(`${json.total} transação(ões) categorizada(s).` +
          (json.preservadas ? ' Alterações feitas durante o processamento foram preservadas.' : '') +
          (json.restantes ? ' Há mais pendências; clique novamente para continuar.' : ''))
      }
    } catch {
      setErro('Não foi possível confirmar a categorização. Você pode tentar novamente; categorias já salvas serão preservadas.')
    } finally {
      router.refresh()
      setOcupado(false)
    }
  }

  if (quantidade === 0 && !mensagem && !erro) return null
  return (
    <section className="rounded-md border border-linha p-5">
      <h2 className="text-sm font-medium">{quantidade} transação(ões) pendente(s) no mês</h2>
      <p className="mt-2 text-sm text-suave">
        Revise os lançamentos abaixo. Abra a categoria de uma transação para
        impedir seu envio à IA. Ao categorizar, você autoriza o envio ao Gemini
        das descrições anonimizadas, datas e valores ainda pendentes.
      </p>
      {quantidade > 0 && (
        <button onClick={categorizar} disabled={ocupado}
          className="mt-4 rounded-md bg-texto px-4 py-2 text-sm text-fundo disabled:opacity-50">
          {ocupado ? 'Categorizando…' : erro ? 'Tentar categorizar novamente' : 'Autorizar e categorizar pendências'}
        </button>
      )}
      {erro && <p role="alert" className="mt-3 text-sm text-suave">{erro}</p>}
      {mensagem && <p role="status" className="mt-3 text-sm text-suave">{mensagem}</p>}
    </section>
  )
}
