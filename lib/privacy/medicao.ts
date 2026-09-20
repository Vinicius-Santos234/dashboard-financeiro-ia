/**
 * A fronteira da medição de audiência — o irmão do `anonymize`.
 *
 * Fica em `lib/privacy` de propósito, ao lado do anonimizador: são os dois
 * lugares do app onde dado sai para terceiro, e os dois precisam ser testáveis
 * sem subir nada.
 */

/**
 * O mínimo que o `beforeSend` do Vercel Web Analytics garante.
 *
 * Só `url`, sem índice aberto: o tipo real do pacote é uma união de eventos
 * com campos próprios, e um `[chave: string]` aqui recusaria todos eles.
 */
export interface EventoDeMedicao {
  url: string
}

/**
 * Corta a query string antes de o evento sair do navegador.
 *
 * O Vercel Web Analytics envia a **URL inteira**. Neste app a query carrega os
 * filtros da tela:
 *
 *     /transacoes?mes=2026-09&categoria=saude
 *
 * `categoria=saude` é dado pessoal sensível na LGPD (art. 5º, II) —
 * informação referente à saúde. Ele entra na URL a cada clique numa fatia da
 * pizza ou numa pílula de filtro. Sem este corte, a Vercel receberia o sinal
 * de que aquele visitante tem gasto com saúde, por um caminho em que **nada dá
 * erro**: o dado vai embora funcionando.
 *
 * O corte é da query **inteira**, e não de uma lista de parâmetros proibidos.
 * Uma lista precisa ser lembrada toda vez que alguém acrescenta um filtro, e é
 * assim que o próximo `?fornecedor=CLINICA+X` vaza. Nenhum parâmetro daqui
 * (`mes`, `categoria`, `ate`, `proximo`) diz sobre audiência nada que o
 * caminho já não diga.
 *
 * Também corta o fragmento (`#`), pela mesma razão e pelo mesmo preço.
 */
export function semQueryString<T extends EventoDeMedicao>(evento: T): T | null {
  try {
    const url = new URL(evento.url)
    url.search = ''
    url.hash = ''
    return { ...evento, url: url.toString() }
  } catch {
    // URL que não faz parse não deveria existir. Se existir, o certo é não
    // enviar nada — e não deixar a original passar por engano.
    return null
  }
}
