'use client'

import { useState } from 'react'
import { formatCents } from '@/lib/domain/money'
import {
  CATEGORIAS,
  CATEGORIA_COR,
  CATEGORIA_LABEL,
  type Categoria,
} from '@/lib/domain/categories'
import { sugerirPadrao } from '@/lib/domain/rules'
import {
  displayAmountCents,
  resolvedFlowType,
  type FlowType,
} from '@/lib/domain/financial-flow'
import { alterarOptOut, corrigirCategoria } from './actions'

interface Transacao {
  fingerprint: string
  occurredOn: string
  amountCents: number
  flowType?: FlowType
  descriptionRaw: string
  descriptionClean: string
  category: Categoria | null
  categorySource: 'ai' | 'rule' | 'user' | null
  aiOptOut: boolean
}

/**
 * A linha, e o painel de edição que fica escondido.
 *
 * A versão anterior tinha um `select` + campo de texto + botão **em toda
 * linha**, sempre visíveis. Trinta lançamentos viravam noventa controles na
 * tela ao mesmo tempo — era, de longe, o elemento menos elegante do app, e
 * transformava a lista num formulário gigante.
 *
 * Agora a linha é só leitura, e a categoria é um botão discreto que abre o
 * painel embaixo. O controle existe no mesmo lugar; o que sumiu foi o ruído de
 * mostrá-lo trinta vezes de uma vez.
 */
export function LinhaTransacao({
  transacao: t,
  demo,
}: {
  transacao: Transacao
  demo: boolean
}) {
  const [aberta, setAberta] = useState(false)

  const flowType = resolvedFlowType(t)
  const valorExibido = displayAmountCents({
    amountCents: t.amountCents,
    description: t.descriptionRaw,
    flowType,
  })

  const cor = t.category ? CATEGORIA_COR[t.category] : 'var(--fraco)'
  const rotuloCategoria = flowType === 'transfer'
    ? 'pagamento / transferência'
    : flowType === 'refund'
      ? `crédito / estorno · ${t.category ? CATEGORIA_LABEL[t.category] : 'sem categoria'}`
      : t.category
        ? CATEGORIA_LABEL[t.category]
        : 'sem categoria'

  return (
    <li className="border-b border-linha last:border-0">
      <div className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-6 py-4">
        <span className="valor text-sm text-fraco">
          {t.occurredOn.slice(8, 10)}/{t.occurredOn.slice(5, 7)}
        </span>

        <span className="min-w-0">
          <span className="block truncate text-sm">{t.descriptionRaw}</span>

          <button
            type="button"
            onClick={() => setAberta((v) => !v)}
            aria-expanded={aberta}
            className="mt-1.5 flex items-center gap-2 text-xs text-fraco transition-colors duration-300 hover:text-suave"
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: cor }}
            />
            {rotuloCategoria}
            {t.aiOptOut && <span className="text-fraco">· fora da IA</span>}
          </button>
        </span>

        <span
          className="valor text-sm"
          style={
            flowType === 'income' || flowType === 'refund'
              ? { color: 'var(--entrada)' }
              : flowType === 'transfer'
                ? { color: 'var(--suave)' }
                : undefined
          }
        >
          {formatCents(valorExibido)}
        </span>
      </div>

      {aberta && (
        <div className="grid grid-cols-[auto_1fr] gap-x-6 pb-5">
          <span />
          <div className="flex flex-col gap-4">
            {flowType === 'transfer' ? (
              <p className="text-xs text-fraco">
                Esta movimentação fica visível, mas não entra em gastos, receitas ou categorias.
              </p>
            ) : demo ? (
              <p className="text-xs text-fraco">
                A conta de demonstração é somente leitura. Crie uma conta para
                corrigir categorias e criar regras.
              </p>
            ) : (
              <>
                <form action={corrigirCategoria} className="flex flex-col gap-3">
                  <input type="hidden" name="fingerprint" value={t.fingerprint} />

                  <div className="flex flex-wrap gap-1.5">
                    {(flowType === 'income'
                      ? (['receita'] as const)
                      : CATEGORIAS.filter((item) => item !== 'receita')).map(
                      (item) => (
                        <label
                          key={item}
                          className="cursor-pointer"
                          title={CATEGORIA_LABEL[item]}
                        >
                          <input
                            type="radio"
                            name="category"
                            value={item}
                            defaultChecked={(t.category ?? 'outros') === item}
                            className="peer sr-only"
                          />
                          <span className="flex items-center gap-2 rounded-full border border-linha px-3 py-1.5 text-xs text-suave transition-colors duration-300 peer-checked:border-texto peer-checked:text-texto hover:border-linha-forte">
                            <span
                              aria-hidden
                              className="size-1.5 rounded-full"
                              style={{ background: CATEGORIA_COR[item] }}
                            />
                            {CATEGORIA_LABEL[item]}
                          </span>
                        </label>
                      )
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-fraco">
                      Aplicar a
                      <input
                        name="pattern"
                        defaultValue={sugerirPadrao(t.descriptionClean)}
                        placeholder="só esta"
                        aria-label="Padrão para próximas transações"
                        className="valor w-40 border-b border-linha bg-transparent px-1 py-1 text-xs text-texto outline-none transition-colors duration-300 focus:border-texto"
                      />
                    </label>

                    <button className="rounded-full bg-texto px-4 py-1.5 text-xs text-fundo transition-opacity duration-300 hover:opacity-85">
                      Salvar
                    </button>
                  </div>

                  <p className="text-xs text-fraco">
                    Deixe o campo vazio para mudar só esta transação. Com um
                    padrão, as próximas que combinarem entram já categorizadas —
                    sem gastar chamada de IA.
                  </p>
                </form>

                <form action={alterarOptOut}>
                  <input type="hidden" name="fingerprint" value={t.fingerprint} />
                  <input type="hidden" name="optOut" value={String(!t.aiOptOut)} />
                  <button className="text-xs text-fraco underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-suave">
                    {t.aiOptOut
                      ? 'Permitir IA na próxima categorização'
                      : 'Impedir próximos envios à IA'}
                  </button>
                  <p className="mt-2 text-xs text-fraco">
                    A escolha vale para os próximos envios e não desfaz chamadas já iniciadas.
                  </p>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
