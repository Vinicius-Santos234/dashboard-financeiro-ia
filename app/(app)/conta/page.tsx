import Link from 'next/link'
import { CATEGORIA_LABEL } from '@/lib/domain/categories'
import { formatCents } from '@/lib/domain/money'
import { diasDesde, DIAS_PARA_RENDA_ENVELHECER } from '@/lib/domain/renda'
import { exigirSessao } from '@/lib/firebase/session'
import {
 lerPerfil,
 listarContas,
 listarImports,
 listarRegras,
} from '@/lib/firestore/repo'
import {
 excluirConta,
 salvarFatura,
 salvarFaturaPadrao,
 salvarRenda,
} from './actions'
import { ControleDeMedicao } from './medicao'

export const maxDuration = 60

export default async function ContaPage() {
 const { uid, email, demo } = await exigirSessao()
 const [imports, regras, perfil, contas] = await Promise.all([
 listarImports(uid),
 listarRegras(uid),
 lerPerfil(uid),
 listarContas(uid),
 ])

 const cartoes = contas.filter((c) => c.kind === 'credit_card')

 const rendaVelha =
 perfil.rendaAtualizadaEm !== null &&
 diasDesde(perfil.rendaAtualizadaEm) > DIAS_PARA_RENDA_ENVELHECER

 return (
 <div className="flex flex-col gap-8">
 <div>
 <h1 className="font-display text-4xl leading-none tracking-tight">Conta</h1>
 <p className="mt-1 text-sm text-suave">{email}</p>
 </div>

 {/* A renda mensal. Spec 003 §5 D4.
     Ela mora no perfil e não no mês: é uma declaração da pessoa, que vale
     até ela mudar. Guardá-la por mês obrigaria a preenchê-la doze vezes
     para ver uma tendência. */}
 <section className="rounded-md border border-linha p-6">
 <h2 className="font-semibold">Renda mensal</h2>
 <p className="mt-2 max-w-2xl text-sm text-suave">
 Serve só para o resumo dizer <em>quanto da sua renda a fatura
 consumiu</em>. Informe a renda <strong>líquida</strong> — o que cai na
 conta, já descontados imposto e INSS. Sem ela, nenhum percentual
 aparece na tela.
 </p>

 {demo ? (
 <p className="mt-4 text-sm text-fraco">
 A conta de demonstração é somente leitura. O valor de exemplo é{' '}
 {perfil.rendaMensalCents === null
 ? 'nenhum'
 : formatCents(perfil.rendaMensalCents)}
 .
 </p>
 ) : (
 <form action={salvarRenda} className="mt-4 flex max-w-md flex-col gap-3">
 <label className="text-sm">
 <span className="mb-1 block">Renda líquida por mês</span>
 <input
 name="renda"
 inputMode="decimal"
 autoComplete="off"
 placeholder="4.500,00"
 defaultValue={
 perfil.rendaMensalCents === null
 ? ''
 : (perfil.rendaMensalCents / 100).toFixed(2).replace('.', ',')
 }
 aria-describedby="ajuda-renda"
 className="valor campo w-full px-3 py-2"
 />
 </label>
 <p id="ajuda-renda" className="text-xs text-fraco">
 Deixe vazio para apagar e voltar a não mostrar percentual.
 {perfil.rendaAtualizadaEm && (
 <>
 {' '}Informada há {diasDesde(perfil.rendaAtualizadaEm)} dia
 {diasDesde(perfil.rendaAtualizadaEm) === 1 ? '' : 's'}
 {rendaVelha && ' — pode estar desatualizada.'}
 </>
 )}
 </p>
 <button className="self-start rounded-md border border-linha-forte px-4 py-2 text-sm transition-colors duration-300 hover:border-texto">
 Salvar renda
 </button>
 </form>
 )}
 </section>

 <section className="rounded-md border border-linha p-6 ">
 <h2 className="font-semibold">Privacidade</h2>
 <div className="mt-3 space-y-2 text-sm text-suave">
 <p>O arquivo enviado é processado em memória e não é armazenado.</p>
 <p>Antes da categorização, CPF, CNPJ, contas, telefones, e-mails, chaves UUID e contrapartes de transferências são removidos.</p>
 {/* Spec 003 §8 C1: o aviso reescrito para o contexto novo. Numa fatura
     o estabelecimento não é resíduo do anonimizador — é o dado central,
     e é por isso que a fatura categoriza bem. Dizer isso é o que torna
     a escolha de bloquear uma linha uma escolha informada. */}
 <p>
 <strong>O nome do estabelecimento é mantido de propósito</strong> — é ele
 que diz no que a fatura foi gasta, e sem ele não há categorização. Numa
 fatura isso não é efeito colateral: é o dado principal, e é o que faz este
 app funcionar melhor com cartão do que com conta corrente.
 </p>
 <p>
 A contrapartida é sua: o nome de uma clínica, farmácia, laboratório,
 advogado ou igreja revela informação sensível sobre você. A importação
 não envia nada à IA — revise os lançamentos e bloqueie os sensíveis
 antes de autorizar a categorização. O bloqueio vale para os próximos
 envios e não desfaz chamadas já iniciadas.
 </p>
 <p>Descrições anonimizadas e agregados podem ser processados pelo Google fora do Brasil.</p>
 </div>
 </section>

 {/* Cookies e medição, separados da privacidade do extrato porque a
     pergunta é outra: aquilo é sobre o seu dado financeiro, isto é sobre
     o que sai daqui enquanto você navega. E é aqui que a revogação
     precisa estar — LGPD art. 8º, §5º pede procedimento facilitado. */}
 <section className="rounded-md border border-linha p-6">
 <h2 className="font-semibold">Cookies e medição</h2>

 <div className="mt-3 space-y-2 text-sm text-suave">
 <p>
 <strong className="text-texto">Este site usa um cookie só:</strong> o de
 sessão, que mantém você logado. Ele é <code>httpOnly</code>, não é lido por
 script nenhum, não vai para terceiros e não serve para publicidade. É
 estritamente necessário — sem ele não há como te entregar uma página
 autenticada —, então ele não depende de consentimento e não pode ser
 desligado. Para removê-lo, saia da conta.
 </p>
 <p>
 <strong className="text-texto">A medição é opcional e está desligada por
 padrão.</strong> Se você autorizar, o site passa a usar Vercel Web
 Analytics e Vercel Speed Insights. Nenhum dos dois usa cookie ou
 identificador persistente de visitante.
 </p>
 <p>
 O que eles enviam: caminho da página, rota, referrer, país, tipo de
 dispositivo, navegador, sistema operacional, velocidade de conexão e as
 métricas de carregamento (Core Web Vitals). A <strong>query string é
 removida antes do envio</strong> — os filtros de mês e de categoria que
 aparecem na URL não saem daqui. Nenhum valor, descrição, categoria ou
 transação sua é enviado, nunca.
 </p>
 <p>
 Recusando, <strong className="text-texto">o script não é carregado</strong>;
 e se você revogar com a página aberta, o envio é interrompido na hora.
 Esses dados, quando enviados, são processados pela Vercel fora do Brasil.
 </p>
 </div>

 <ControleDeMedicao />
 </section>

 {/* A fatura como período. Spec 003 §5 D2 e §8 C8.
     Só aparece para cartão: conta corrente não tem fechamento, e o mês
     civil dela nunca deixou de ser a unidade certa. */}
 <section className="rounded-md border border-linha p-6">
 <h2 className="font-semibold">Fechamento da fatura</h2>
 <p className="mt-2 max-w-2xl text-sm text-suave">
 Com o dia do fechamento, uma compra feita depois dele entra na fatura
 seguinte — que é como o cartão cobra. Sem ele, o app agrupa pelo mês
 civil, e compras da mesma fatura ficam partidas em dois meses.
 </p>
 {/* O aviso que evita a confusão mais cara desta tela: fechamento não é
     vencimento, e vários bancos nomeiam o arquivo exportado pela data
     de vencimento. */}
 <p className="mt-2 max-w-2xl text-sm text-suave">
 <strong className="text-texto">Fechamento não é vencimento.</strong> O
 fechamento costuma cair alguns dias antes, e é ele que separa uma
 fatura da outra. Se o arquivo que seu banco exporta tem uma data no
 nome, ela normalmente é a do <em>vencimento</em> — confira na própria
 fatura qual é o dia em que ela fecha.
 </p>

 {cartoes.length === 0 ? (
 // A configuração precisa existir ANTES da primeira importação: é ela
 // que decide como a primeira fatura vai ser agrupada. Sem isto, a
 // ordem forçada era importar torto, descobrir, configurar e migrar.
 <>
 <p className="mt-4 max-w-2xl text-sm text-suave">
 Você ainda não importou nenhuma fatura. Se informar o dia agora, a
 primeira importação já agrupa certo — e você não precisa migrar nada
 depois.
 </p>
 {demo ? (
 <p className="mt-4 text-sm text-fraco">
 A conta de demonstração é somente leitura.
 </p>
 ) : (
 <form action={salvarFaturaPadrao} className="mt-4 flex flex-wrap items-end gap-4">
 <label className="text-sm">
 <span className="mb-1 block text-xs text-fraco">Fecha no dia</span>
 <input
 name="closingDay"
 inputMode="numeric"
 autoComplete="off"
 defaultValue={perfil.fechamentoPadraoCartao ?? ''}
 placeholder="—"
 className="valor campo w-20 px-3 py-2"
 />
 </label>
 <label className="text-sm">
 <span className="mb-1 block text-xs text-fraco">Vence no dia</span>
 <input
 name="dueDay"
 inputMode="numeric"
 autoComplete="off"
 defaultValue={perfil.vencimentoPadraoCartao ?? ''}
 placeholder="—"
 className="valor campo w-20 px-3 py-2"
 />
 </label>
 <button className="rounded-md border border-linha-forte px-4 py-2 text-sm transition-colors duration-300 hover:border-texto">
 Salvar
 </button>
 </form>
 )}
 </>
 ) : (
 <>
 <p className="mt-2 max-w-2xl text-xs text-fraco">
 Mudar aqui vale para as <strong>próximas</strong> importações. Para
 mover o que já está gravado, rode <code>npm run migrar:faturas</code>,
 que faz backup antes e confere o recálculo depois.
 </p>

 <div className="mt-5 flex flex-col gap-6">
 {cartoes.map((cartao) => (
 <form
 key={cartao.id}
 action={salvarFatura}
 className="flex flex-wrap items-end gap-4 border-t border-linha pt-4 first:border-0 first:pt-0"
 >
 <input type="hidden" name="accountId" value={cartao.id} />
 <div className="min-w-40 grow">
 <p className="text-sm font-medium">{cartao.name}</p>
 <p className="text-xs text-fraco">
 {cartao.closingDay === null
 ? 'agrupando pelo mês civil'
 : `fecha dia ${cartao.closingDay}`}
 {cartao.closingDayFonte === 'arquivo' && ' · sugerido pelo arquivo'}
 </p>
 </div>
 <label className="text-sm">
 <span className="mb-1 block text-xs text-fraco">Fecha no dia</span>
 <input
 name="closingDay"
 inputMode="numeric"
 autoComplete="off"
 disabled={demo}
 defaultValue={cartao.closingDay ?? ''}
 placeholder="—"
 className="valor campo w-20 px-3 py-2 disabled:opacity-40"
 />
 </label>
 <label className="text-sm">
 <span className="mb-1 block text-xs text-fraco">Vence no dia</span>
 <input
 name="dueDay"
 inputMode="numeric"
 autoComplete="off"
 disabled={demo}
 defaultValue={cartao.dueDay ?? ''}
 placeholder="—"
 className="valor campo w-20 px-3 py-2 disabled:opacity-40"
 />
 </label>
 {!demo && (
 <button className="rounded-md border border-linha-forte px-4 py-2 text-sm transition-colors duration-300 hover:border-texto">
 Salvar
 </button>
 )}
 </form>
 ))}
 </div>
 </>
 )}
 </section>

 <section className="rounded-md border border-linha">
 <div className="border-b border-linha px-5 py-4 ">
 <h2 className="font-semibold">Últimas importações</h2>
 </div>
 {imports.length === 0 ? (
 <p className="p-5 text-sm text-suave">Nenhuma importação.</p>
 ) : (
 <div className="overflow-x-auto">
 <table className="w-full text-left text-sm">
 <thead className="text-suave">
 <tr>
 <th className="px-5 py-2 font-medium">Arquivo</th>
 <th className="px-5 py-2 font-medium">Período</th>
 <th className="px-5 py-2 text-right font-medium">Importadas</th>
 <th className="px-5 py-2 text-right font-medium">Duplicadas</th>
 <th className="px-5 py-2 font-medium">Status</th>
 </tr>
 </thead>
 <tbody>
 {imports.map((item) => (
 <tr key={item.id} className="border-t border-linha">
 <td className="px-5 py-2.5">{item.filename}</td>
 <td className="px-5 py-2.5 text-suave">{item.periodStart ?? '—'} a {item.periodEnd ?? '—'}</td>
 <td className="px-5 py-2.5 text-right tabular-nums">{item.rowsImported}</td>
 <td className="px-5 py-2.5 text-right tabular-nums">{item.rowsDuplicated}</td>
 <td className="px-5 py-2.5">{item.status}
 <a className="ml-2 underline" href={`/transacoes${item.periodStart ? `?mes=${item.periodStart.slice(0, 7)}` : ''}`}>
 Revisar pendências
 </a>
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </section>

 <section className="rounded-md border border-linha p-6 ">
 <h2 className="font-semibold">Regras aprendidas</h2>
 {regras.length === 0 ? (
 <p className="mt-2 text-sm text-suave">Nenhuma correção salva ainda.</p>
 ) : (
 <>
 <ul className="mt-3 grid gap-2 sm:grid-cols-2">
 {regras.slice(0, 6).map((regra) => (
 <li key={regra.id} className="rounded-md border border-linha px-3 py-2 text-sm">
 <span className="font-medium">{regra.pattern}</span>
 <span className="ml-2 text-suave">
 → {regra.category === null ? 'só o tipo' : CATEGORIA_LABEL[regra.category]} · {regra.hits} uso(s)
 </span>
 </li>
 ))}
 </ul>
 <Link
 href="/regras"
 className="mt-4 inline-block text-sm text-texto underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:decoration-texto"
 >
 Ver, editar e apagar as {regras.length} regras
 </Link>
 </>
 )}
 </section>

 <section className="rounded-md p-6"
        style={{ border: '1px solid color-mix(in oklab, var(--alarme) 40%, transparent)' }}>
 <h2 className="font-display text-xl" style={{ color: 'var(--alarme)' }}>Excluir conta e dados</h2>
 <p className="mt-2 text-sm text-suave">
 A exclusão remove permanentemente transações, imports, regras, insights, contas e o usuário do Firebase Auth.
 </p>
 <form action={excluirConta} className="mt-4 flex max-w-md flex-col gap-3">
 <label className="text-sm">
 <span className="mb-1 block">Digite <strong>EXCLUIR</strong> para confirmar</span>
 <input
 name="confirmacao"
 required
 pattern="EXCLUIR"
 autoComplete="off"
 className="campo w-full px-3 py-2"
 />
 </label>
 <button className="self-start rounded-md border border-linha-forte px-4 py-2 text-sm font-medium transition-colors duration-300">
 Excluir permanentemente
 </button>
 </form>
 </section>
 </div>
 )
}
