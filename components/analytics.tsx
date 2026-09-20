'use client'

import { useEffect, useState } from 'react'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import {
  EVENTO_CONSENTIMENTO,
  gravarConsentimento,
  lerConsentimento,
  podeMedir,
  type Consentimento,
} from '@/lib/privacy/consentimento'
import { semQueryString } from '@/lib/privacy/medicao'

/**
 * O portão que roda **a cada envio**, e por que ele é necessário.
 *
 * Desmontar o componente não descarrega nada: os dois pacotes injetam o script
 * em `document.head` dentro de um `useEffect` **sem função de cleanup**. Depois
 * de montado, o runtime é do documento, não do React — e continua rastreando
 * navegação por conta própria.
 *
 * O que sobrevive junto é o `beforeSend`, registrado em `window.va` / `window.si`.
 * Por isso a revogação precisa ser conferida **aqui**, e não só na montagem:
 * é este o único ponto que o script já carregado ainda consulta.
 *
 * As duas defesas juntas cobrem os dois momentos:
 *
 *   - **carga nova** sem consentimento → o componente não monta, o script não existe;
 *   - **revogação na mesma aba** → o script existe e este portão descarta tudo.
 *
 * Uma sozinha deixa buraco, e foi exatamente o buraco que uma revisão externa
 * achou: eu tinha conferido que navegar depois de revogar não reportava, mas
 * navegar ali era recarregar a página — o caso que a montagem já cobria.
 */
function enviarSePermitido<T extends { url: string }>(evento: T): T | null {
  if (!podeMedir(lerConsentimento())) return null
  return semQueryString(evento)
}

/**
 * A medição, e o portão que decide se ela existe.
 *
 * Duas proteções empilhadas, e elas resolvem coisas diferentes:
 *
 * 1. **O consentimento decide se o script é montado.** Recusado, nada é
 *    renderizado — sem `<script>`, sem requisição. É bloqueio, e não filtro:
 *    um `beforeSend` devolvendo `null` ainda teria carregado o script.
 * 2. **O `beforeSend` corta a query string** do que é enviado quando a pessoa
 *    aceita. Aceitar medição não é aceitar que `?categoria=saude` viaje junto
 *    — ver `lib/privacy/medicao.ts`.
 *
 * Os dois produtos da Vercel entram pelo mesmo portão porque coletam a mesma
 * coisa sobre a visita: o Speed Insights também manda a URL, além das métricas
 * de carregamento.
 */
export function Medicao() {
  // `null` até o primeiro efeito rodar. Ler `localStorage` na renderização
  // quebraria a hidratação — o servidor não tem como saber a resposta.
  const [consentimento, setConsentimento] = useState<Consentimento | null>(null)
  const [decidido, setDecidido] = useState(false)

  useEffect(() => {
    const sincronizar = () => {
      setConsentimento(lerConsentimento())
      setDecidido(true)
    }
    sincronizar()
    window.addEventListener(EVENTO_CONSENTIMENTO, sincronizar)
    return () => window.removeEventListener(EVENTO_CONSENTIMENTO, sincronizar)
  }, [])

  const medindo = decidido && podeMedir(consentimento)

  return (
    <>
      {medindo && (
        <>
          <Analytics beforeSend={enviarSePermitido} />
          <SpeedInsights beforeSend={enviarSePermitido} />
        </>
      )}
      {decidido && consentimento === null && <BannerDeConsentimento />}
    </>
  )
}

/**
 * O banner.
 *
 * Fica no rodapé e não cobre a página inteira: ele pergunta sobre medição, e
 * não sobre o serviço — sequestrar a tela para isso seria desproporcional ao
 * que está em jogo. Também não tem "X" que fecha sem responder: fechar sem
 * decidir deixaria a pessoa achando que aceitou, quando o padrão é recusar.
 */
function BannerDeConsentimento() {
  const [saindo, setSaindo] = useState(false)

  function responder(valor: Consentimento) {
    setSaindo(true)
    gravarConsentimento(valor)
  }

  if (saindo) return null

  return (
    <div
      role="dialog"
      aria-labelledby="consentimento-titulo"
      aria-describedby="consentimento-texto"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-linha-forte bg-fundo"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:gap-8">
        <div className="grow">
          <p id="consentimento-titulo" className="rotulo">
            Medição de audiência
          </p>
          <p
            id="consentimento-texto"
            className="mt-2 text-sm leading-relaxed text-suave"
          >
            Posso medir como o site é usado — caminho das páginas, país,
            dispositivo e velocidade de carregamento? <strong className="text-texto">
            Sem cookie e sem identificador de visitante</strong>, e nenhum valor,
            descrição ou transação sua é enviado. O cookie de sessão, que mantém
            você logado, não depende desta escolha.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => responder('recusado')}
            className="rounded-md border border-linha-forte px-4 py-2 text-sm text-suave transition-colors duration-300 hover:border-texto hover:text-texto"
          >
            Não medir
          </button>
          <button
            type="button"
            onClick={() => responder('aceito')}
            className="rounded-md bg-texto px-4 py-2 text-sm font-medium text-fundo transition-opacity duration-300 hover:opacity-85"
          >
            Pode medir
          </button>
        </div>
      </div>
    </div>
  )
}
