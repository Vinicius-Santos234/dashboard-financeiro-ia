'use client'

import { useId, useState } from 'react'
import {
  CATEGORIAS,
  CATEGORIA_COR,
  CATEGORIA_LABEL,
  type Categoria,
} from '@/lib/domain/categories'
import { FLOW_LABEL } from '@/lib/domain/financial-flow'
import type { FlowType } from '@/lib/domain/financial-flow'
import { editarRegra, removerRegra } from './actions'

interface Regra {
  id: string
  pattern: string
  /** `null` numa regra que só impõe o fluxo e deixa a categoria em aberto. */
  category: Categoria | null
  hits: number
  flowType?: FlowType
}

/**
 * Uma regra na lista, e o painel que abre para editá-la.
 *
 * Mesmo padrão da linha de transação: a lista é leitura, e o controle só
 * aparece quando a pessoa pede. Vinte regras com um `select` e dois botões
 * cada seriam sessenta controles na tela ao mesmo tempo.
 *
 * **Apagar é uma por vez, sem seleção múltipla** (003 §10). Não existe
 * desfazer, e apagar em lote por engano desfaria meses de correção manual.
 */
export function LinhaRegra({ regra, demo }: { regra: Regra; demo: boolean }) {
  const [aberta, setAberta] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  const painelId = useId()

  return (
    <>
      <tr className={aberta ? undefined : 'border-b border-linha last:border-0'}>
        <td className="py-4 pr-6 align-baseline">
          <span className="valor block truncate text-sm">{regra.pattern}</span>
        </td>

        <td className="py-4 pr-6 align-baseline">
          <span className="flex flex-wrap items-center gap-2 text-sm">
            {regra.category === null ? (
              // Regra só de fluxo: ela muda o tipo do lançamento e deixa a
              // categoria para a IA, como se a linha tivesse acabado de entrar.
              <span className="text-fraco">só o tipo · categoria em aberto</span>
            ) : (
              <>
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: CATEGORIA_COR[regra.category] }}
                />
                {CATEGORIA_LABEL[regra.category]}
              </>
            )}
            {/* Uma regra que também impõe fluxo mudou um total, e não só uma
                fatia. Esconder isso faria a pessoa procurar no lugar errado
                quando o número do mês não batesse. */}
            {regra.flowType && (
              <span className="rotulo border border-linha px-1.5 py-0.5 text-fraco">
                {FLOW_LABEL[regra.flowType]}
              </span>
            )}
          </span>
        </td>

        <td className="valor py-4 text-right align-baseline text-sm text-suave">
          {regra.hits}
        </td>

        <td className="py-4 text-right align-baseline">
          {!demo && (
            <button
              type="button"
              onClick={() => {
                setAberta((v) => !v)
                setConfirmando(false)
              }}
              aria-expanded={aberta}
              aria-controls={painelId}
              className="text-xs text-fraco underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-texto"
            >
              {aberta ? 'Fechar' : 'Editar'}
            </button>
          )}
        </td>
      </tr>

      {aberta && (
        <tr id={painelId} className="border-b border-linha last:border-0">
          <td colSpan={4} className="pb-5">
            <div className="flex flex-col gap-5">
              <form action={editarRegra} className="flex flex-col gap-3">
                <input type="hidden" name="id" value={regra.id} />

                <p className="rotulo">Mudar a categoria</p>
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORIAS.map((item) => (
                    <label key={item} className="cursor-pointer" title={CATEGORIA_LABEL[item]}>
                      <input
                        type="radio"
                        name="category"
                        value={item}
                        defaultChecked={regra.category === item}
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
                  ))}
                </div>

                <button className="self-start rounded-full bg-texto px-4 py-1.5 text-xs text-fundo transition-opacity duration-300 hover:opacity-85">
                  Salvar
                </button>
              </form>

              <div className="border-t border-linha pt-4">
                {confirmando ? (
                  <form action={removerRegra} className="flex flex-wrap items-center gap-3">
                    <input type="hidden" name="id" value={regra.id} />
                    <p className="text-xs text-suave">
                      Apagar <span className="valor">{regra.pattern}</span>? As
                      transações já categorizadas continuam como estão.
                    </p>
                    <button
                      className="rounded-full border px-4 py-1.5 text-xs transition-colors duration-300"
                      style={{
                        borderColor: 'color-mix(in oklab, var(--alarme) 50%, transparent)',
                        color: 'var(--alarme)',
                      }}
                    >
                      Apagar mesmo
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmando(false)}
                      className="text-xs text-fraco underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-texto"
                    >
                      Cancelar
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmando(true)}
                    className="text-xs text-fraco underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-texto"
                  >
                    Apagar esta regra
                  </button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
