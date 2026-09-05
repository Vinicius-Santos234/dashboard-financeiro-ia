/**
 * Os caminhos da árvore. Spec §4.1.
 *
 * Este arquivo é pequeno e é a peça mais importante da segurança do lado
 * servidor. O Admin SDK **ignora as Security Rules** (§4.4), então não existe
 * uma camada abaixo que corrija um acesso errado. O que existe é isto: toda
 * função recebe o `uid` como primeiro argumento e monta o caminho a partir
 * dele.
 *
 * A consequência prática é que **não há query global para alguém esquecer de
 * filtrar**. `where('userId', '==', uid)` pode ser omitido num `select` novo e
 * nada quebra; um caminho não pode ser omitido, porque sem ele não há o que
 * consultar.
 *
 * É uma garantia mais fraca que a RLS do Postgres e mais forte que um filtro
 * opcional. O README diz isso com estas palavras.
 */

export const usuario = (uid: string) => `users/${uid}`

export const contas = (uid: string) => `users/${uid}/accounts`
export const conta = (uid: string, accountId: string) => `${contas(uid)}/${accountId}`

export const importacoes = (uid: string) => `users/${uid}/imports`
export const importacao = (uid: string, importId: string) =>
  `${importacoes(uid)}/${importId}`

export const transacoes = (uid: string) => `users/${uid}/transactions`
export const transacao = (uid: string, fingerprint: string) =>
  `${transacoes(uid)}/${fingerprint}`

export const regras = (uid: string) => `users/${uid}/rules`
export const regra = (uid: string, padrao: string) => `${regras(uid)}/${padrao}`

export const insights = (uid: string) => `users/${uid}/insights`
/** `periodo` é sempre `YYYY-MM`. */
export const insight = (uid: string, periodo: string) => `${insights(uid)}/${periodo}`

export const rollups = (uid: string) => `users/${uid}/rollups`
export const rollup = (uid: string, mes: string) => `${rollups(uid)}/${mes}`

/**
 * Id de documento no Firestore não pode conter `/`, ser `.` ou `..`, nem casar
 * com `__.*__`. Os fingerprints já saem seguros por construção (§4.3), mas o
 * padrão de uma `rule` vem de descrição de banco e precisa ser saneado.
 */
export function idSeguro(bruto: string): string {
  const limpo = bruto
    .replace(/[/\\.#$[\]]/g, '_')
    .replace(/^__+|__+$/g, '_')
    .slice(0, 300)
    .trim()

  return limpo === '' || limpo === '_' ? 'sem_padrao' : limpo
}
