/**
 * O consentimento de medição, e o que ele de fato controla.
 *
 * **Este app usa exatamente um cookie: o de sessão** (`sessao`, `httpOnly`),
 * que existe para você continuar logado. Ele é estritamente necessário — sem
 * ele não há como servir a página que você pediu —, e por isso não depende de
 * consentimento nem pode ser desligado. Desligá-lo seria o mesmo que deslogar.
 *
 * O que o consentimento controla é a **medição**: Vercel Web Analytics e Speed
 * Insights. Nenhum dos dois usa cookie, mas os dois enviam dados sobre a sua
 * visita (caminho, referrer, país, dispositivo, navegador, e as métricas de
 * carregamento) para um terceiro, fora do Brasil. Na LGPD isso é tratamento de
 * dado pessoal, e é sobre isso que se pergunta.
 *
 * Por isso a recusa **não filtra** o envio: ela impede o script de ser
 * montado. Sem componente, sem script, sem requisição — bloqueio de verdade,
 * e não um `beforeSend` devolvendo `null` com o script já carregado.
 */

/** A chave é versionada: mudar o que se coleta invalida o consentimento dado. */
export const CHAVE_CONSENTIMENTO = 'medicao-consentimento-v1'

export type Consentimento = 'aceito' | 'recusado'

/**
 * Enquanto a pessoa não decide, **não se mede**.
 *
 * É a leitura defensável da LGPD para tratamento que não é necessário ao
 * serviço: a base legal precisa existir antes do tratamento, não depois. O
 * preço é perder a medição de quem fecha a aba sem responder, e ele é aceito
 * de propósito — o contrário seria medir primeiro e perguntar depois.
 */
export const PADRAO_ANTES_DE_DECIDIR: Consentimento = 'recusado'

/** Disparado quando a escolha muda, para a medição montar ou desmontar na hora. */
export const EVENTO_CONSENTIMENTO = 'medicao-consentimento-mudou'

function armazenamento(): Storage | null {
  try {
    // Janela anônima, dados bloqueados ou storage cheio: o acessor em si pode
    // lançar. Sem armazenamento, o app funciona e a pergunta volta a cada
    // visita — que é o comportamento seguro.
    return window.localStorage
  } catch {
    return null
  }
}

/** `null` = ainda não respondeu. Não é o mesmo que ter recusado. */
export function lerConsentimento(): Consentimento | null {
  const store = armazenamento()
  if (!store) return null
  try {
    const bruto = store.getItem(CHAVE_CONSENTIMENTO)
    return bruto === 'aceito' || bruto === 'recusado' ? bruto : null
  } catch {
    return null
  }
}

export function gravarConsentimento(valor: Consentimento): void {
  const store = armazenamento()
  try {
    store?.setItem(CHAVE_CONSENTIMENTO, valor)
  } catch {
    // Não poder gravar não impede de respeitar a escolha nesta sessão.
  }
  avisarMudanca()
}

/** Volta ao estado de não respondido: o banner pergunta de novo. */
export function limparConsentimento(): void {
  const store = armazenamento()
  try {
    store?.removeItem(CHAVE_CONSENTIMENTO)
  } catch {
    // idem
  }
  avisarMudanca()
}

function avisarMudanca(): void {
  try {
    window.dispatchEvent(new Event(EVENTO_CONSENTIMENTO))
  } catch {
    // Sem `window` (SSR) não há o que avisar.
  }
}

/**
 * Deve medir?
 *
 * Separada da leitura para poder ser testada sem navegador, e para o padrão
 * de "ainda não respondeu" ficar num lugar só.
 */
export function podeMedir(consentimento: Consentimento | null): boolean {
  return (consentimento ?? PADRAO_ANTES_DE_DECIDIR) === 'aceito'
}

/** O que cada estado significa na tela de Conta. */
export const CONSENTIMENTO_LABEL: Record<Consentimento, string> = {
  aceito: 'Medição ativada',
  recusado: 'Medição desativada',
}
