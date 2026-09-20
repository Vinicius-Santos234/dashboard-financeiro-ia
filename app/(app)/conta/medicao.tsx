'use client'

import { useEffect, useState } from 'react'
import {
  EVENTO_CONSENTIMENTO,
  gravarConsentimento,
  lerConsentimento,
  limparConsentimento,
  podeMedir,
  type Consentimento,
} from '@/lib/privacy/consentimento'

/**
 * Revogar a medição, a qualquer momento.
 *
 * Consentimento que não se retira não é consentimento — na LGPD, o titular
 * pode revogar "a qualquer momento, mediante manifestação expressa, por
 * procedimento gratuito e facilitado" (art. 8º, §5º). Deixar isso só no banner
 * que aparece uma vez não cumpre "facilitado".
 *
 * A mudança vale **na hora**: `gravarConsentimento` dispara um evento que o
 * `<Medicao>` do layout escuta, e o script é montado ou desmontado sem
 * recarregar a página.
 */
export function ControleDeMedicao() {
  const [consentimento, setConsentimento] = useState<Consentimento | null>(null)
  const [carregado, setCarregado] = useState(false)

  useEffect(() => {
    const sincronizar = () => {
      setConsentimento(lerConsentimento())
      setCarregado(true)
    }
    sincronizar()
    window.addEventListener(EVENTO_CONSENTIMENTO, sincronizar)
    return () => window.removeEventListener(EVENTO_CONSENTIMENTO, sincronizar)
  }, [])

  // Antes de ler o armazenamento não dá para afirmar nada, e afirmar errado
  // aqui — "medição ativada" quando está desligada — é pior que esperar.
  if (!carregado) {
    return <p className="mt-3 text-sm text-fraco">Verificando…</p>
  }

  const medindo = podeMedir(consentimento)

  return (
    <div className="mt-4">
      <p className="text-sm">
        Agora:{' '}
        <strong className={medindo ? 'text-texto' : undefined}>
          {medindo ? 'medição ativada' : 'medição desativada'}
        </strong>
        {consentimento === null && (
          <span className="text-fraco"> — você ainda não respondeu, e o padrão é não medir</span>
        )}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => gravarConsentimento(medindo ? 'recusado' : 'aceito')}
          className="rounded-md border border-linha-forte px-4 py-2 text-sm transition-colors duration-300 hover:border-texto"
        >
          {medindo ? 'Desativar medição' : 'Ativar medição'}
        </button>

        {consentimento !== null && (
          <button
            type="button"
            onClick={limparConsentimento}
            className="text-sm text-fraco underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-texto"
          >
            Esquecer minha resposta
          </button>
        )}
      </div>

      <p className="mt-3 text-xs text-fraco">
        Desativar interrompe o envio na hora, e na próxima visita o script nem
        chega a ser carregado. A escolha fica neste navegador, e não na sua
        conta: guardá-la no servidor exigiria identificar você para saber que
        não quer ser identificado.
      </p>
    </div>
  )
}
