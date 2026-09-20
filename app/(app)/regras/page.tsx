import { exigirSessao } from '@/lib/firebase/session'
import { listarRegras } from '@/lib/firestore/repo'
import { LinhaRegra } from './linha'

/**
 * As regras aprendidas, visíveis e editáveis. Spec 003 §8 C4.
 *
 * O defeito que esta tela fecha tem nome: **o app aprende e a pessoa não vê o
 * que ele aprendeu**. Uma correção errada virava regra, a regra voltava a
 * aplicar a categoria errada em todo import seguinte, e não havia caminho de
 * volta — nem para ver, nem para apagar.
 */
export default async function RegrasPage() {
  const { uid, demo } = await exigirSessao()
  const regras = await listarRegras(uid)

  // Mais usadas primeiro: são as que mais custam se estiverem erradas.
  const ordenadas = [...regras].sort(
    (a, b) => b.hits - a.hits || a.pattern.localeCompare(b.pattern)
  )

  return (
    <div className="flex flex-col gap-10">
      <header>
        <p className="rotulo">O que o app aprendeu</p>
        <h1 className="mt-2 font-display text-4xl leading-none tracking-tight sm:text-5xl">
          Regras
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-suave">
          Cada correção sua que veio com um padrão virou uma regra. Nos próximos
          imports, toda descrição que contiver o padrão entra já categorizada —
          sem gastar chamada de IA. Apagar uma regra não muda o que ela já
          categorizou; ela só deixa de ser aplicada daqui para a frente.
        </p>
      </header>

      {ordenadas.length === 0 ? (
        <div className="border border-dashed border-linha px-8 py-16 text-center">
          <p className="text-sm text-suave">Nenhuma regra ainda.</p>
          <a
            href="/transacoes"
            className="mt-3 inline-block text-sm text-texto underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:decoration-texto"
          >
            Corrigir uma transação cria a primeira
          </a>
        </div>
      ) : (
        <section>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Regras de categorização aprendidas com suas correções
            </caption>
            <thead>
              <tr className="border-b border-linha">
                <th scope="col" className="rotulo pb-3 font-medium">
                  Quando a descrição contém
                </th>
                <th scope="col" className="rotulo pb-3 font-medium">
                  A transação vira
                </th>
                <th scope="col" className="rotulo w-20 pb-3 text-right font-medium">
                  Usos
                </th>
                <th scope="col" className="rotulo w-24 pb-3 text-right font-medium">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ordenadas.map((regra) => (
                <LinhaRegra key={regra.id} regra={regra} demo={demo} />
              ))}
            </tbody>
          </table>

          <p className="mt-6 text-xs text-fraco">
            {ordenadas.length} regra{ordenadas.length === 1 ? '' : 's'} · apagar é
            uma por vez, e não tem desfazer
          </p>
        </section>
      )}
    </div>
  )
}
