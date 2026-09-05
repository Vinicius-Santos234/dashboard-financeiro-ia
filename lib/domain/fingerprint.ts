import { createHash } from 'node:crypto'
import type { RawTransaction } from '@/lib/sources/types'

/**
 * A garantia de que reimportar o mesmo extrato não dobra o gráfico.
 * Spec §4.3.
 */

/** Maiúsculas, sem acento, espaços colapsados. Só para o hash. */
export function normalizeDescription(descricao: string): string {
  return descricao
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function sha256(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * Sempre hash hexadecimal com prefixo, e não a string legível.
 *
 * O fingerprint é o **id do documento** no Firestore (spec §4.3), e id de
 * documento não pode conter `/` — que é exatamente o que aparece em FITID de
 * alguns bancos. Hash resolve por construção, e o prefixo preserva a única
 * informação que a legibilidade dava: de onde veio a identidade.
 */
export function fingerprintPorFitid(accountId: string, fitid: string): string {
  return 'ofx_' + sha256([accountId, fitid].join('|'))
}

export function fingerprintPorConteudo(
  accountId: string,
  occurredOn: string,
  amountCents: number,
  descricao: string,
  seq: number
): string {
  const material = [
    accountId,
    occurredOn,
    String(amountCents),
    normalizeDescription(descricao),
    String(seq),
  ].join('|')

  return 'h_' + sha256(material)
}

export interface ComFingerprint extends RawTransaction {
  /** A identidade que será gravada, se a linha for nova. */
  fingerprint: string
  /**
   * As outras identidades que ESTA MESMA linha teria recebido sob outra
   * circunstância. A deduplicação casa por qualquer uma delas.
   *
   * Existe por um motivo específico (§4.3): a escolha entre FITID e hash de
   * conteúdo depende de quantas vezes o FITID aparece **no arquivo atual**, e
   * isso muda entre arquivos que se sobrepõem. Arquivo A traz o FITID `X`
   * duas vezes, então as duas linhas viram `h_…`; arquivo B traz só uma
   * delas, `X` aparece uma vez, e ela viraria `ofx_…` — entrando de novo como
   * se fosse transação nova. Guardando as duas formas, a linha é reconhecida
   * pela que já está gravada, independente de como o arquivo atual a
   * classificou.
   */
  alternativos: string[]
}

/**
 * Calcula a identidade de cada transação do arquivo.
 *
 * Duas sutilezas, e as duas já custaram bug em app de finanças:
 *
 * 1. **`seq`.** Dois cafés de R$ 8,00 no mesmo lugar no mesmo dia são duas
 *    transações legítimas e idênticas. Sem um contador de ocorrência, a
 *    segunda seria descartada como duplicata e o extrato ficaria menor que a
 *    realidade. `seq` é o índice da ocorrência daquele tuplo dentro do
 *    arquivo — determinístico, então reimportar o mesmo arquivo dá o mesmo
 *    resultado.
 *
 * 2. **FITID repetido.** O FITID deveria ser único por conta, mas há banco que
 *    emite o mesmo para linhas diferentes. Confiar cegamente faria a segunda
 *    linha ser recusada como duplicata. Quando um FITID se repete dentro do
 *    arquivo, todas as linhas que o compartilham caem para o hash de conteúdo
 *    — e guardam a forma por FITID em `alternativos`, para o caso de outro
 *    arquivo classificar a mesma linha de outro jeito.
 */
export function atribuirFingerprints(
  accountId: string,
  transacoes: readonly RawTransaction[]
): ComFingerprint[] {
  const vezesQueOFitidAparece = new Map<string, number>()
  for (const t of transacoes) {
    if (t.fitid) {
      vezesQueOFitidAparece.set(
        t.fitid,
        (vezesQueOFitidAparece.get(t.fitid) ?? 0) + 1
      )
    }
  }

  const ocorrencias = new Map<string, number>()

  return transacoes.map((t) => {
    // O hash de conteúdo é calculado SEMPRE, mesmo quando o FITID vai ser a
    // identidade escolhida: é ele que dá estabilidade entre arquivos.
    const chave = [
      t.occurredOn,
      t.amountCents,
      normalizeDescription(t.description),
    ].join('|')

    const seq = ocorrencias.get(chave) ?? 0
    ocorrencias.set(chave, seq + 1)

    const porConteudo = fingerprintPorConteudo(
      accountId,
      t.occurredOn,
      t.amountCents,
      t.description,
      seq
    )

    const temFitid = t.fitid !== undefined && t.fitid !== ''
    const porFitid = temFitid ? fingerprintPorFitid(accountId, t.fitid!) : null

    const fitidConfiavel = temFitid && vezesQueOFitidAparece.get(t.fitid!) === 1

    if (fitidConfiavel && porFitid) {
      return { ...t, fingerprint: porFitid, alternativos: [porConteudo] }
    }

    // FITID repetido NÃO vira alternativo — e esta linha custou um bug.
    //
    // Quando o banco repete o FITID, todas as linhas que o compartilham teriam
    // o mesmo alternativo `ofx_…`. Se uma delas já estivesse gravada, as
    // OUTRAS seriam acusadas de duplicata e **desapareceriam**: importar
    // "COMPRA A" (FITID X, único) e depois um arquivo com "COMPRA A" e
    // "COMPRA B" ambas com X faz a B sumir.
    //
    // É exatamente o estrago que o `seq` existe para evitar, entrando por
    // outra porta. E um FITID que se repete é, por definição, uma identidade
    // que não identifica — não serve nem como pista.
    return { ...t, fingerprint: porConteudo, alternativos: [] }
  })
}

export interface SeparacaoDuplicadas {
  novas: ComFingerprint[]
  duplicadas: ComFingerprint[]
}

/**
 * Separa o que é novo do que já está no banco.
 *
 * `jaExistentes` são os ids de documento já gravados sob `users/{uid}` — o
 * caminho já garante que são só do próprio usuário, então não há filtro aqui.
 *
 * Casa pelo fingerprint **e pelos alternativos**: a mesma linha pode ter sido
 * gravada sob a outra forma de identidade, se o arquivo anterior a classificou
 * de outro jeito (ver `ComFingerprint.alternativos`). Comparar só a forma
 * escolhida agora deixaria passar a mesma transação duas vezes.
 *
 * Também remove duplicata **dentro do próprio lote**: se a mesma identidade
 * aparecer duas vezes, só a primeira entra.
 */
export function separarDuplicadas(
  transacoes: readonly ComFingerprint[],
  jaExistentes: Iterable<string>
): SeparacaoDuplicadas {
  const vistos = new Set(jaExistentes)
  const novas: ComFingerprint[] = []
  const duplicadas: ComFingerprint[] = []

  for (const t of transacoes) {
    if (
      vistos.has(t.fingerprint) ||
      t.alternativos.some((id) => vistos.has(id))
    ) {
      duplicadas.push(t)
      continue
    }

    // Registra SÓ a identidade primária, nunca os alternativos.
    //
    // Registrar os alternativos parece simétrico e quebra o caso que mais
    // importa: quando o banco repete um FITID, as duas linhas do arquivo
    // compartilham o mesmo alternativo por FITID — e a segunda seria acusada
    // de duplicata da primeira, que é exatamente o dado real sendo comido.
    //
    // Os alternativos servem para reconhecer o que JÁ ESTÁ GRAVADO sob outra
    // forma; dentro de um mesmo arquivo a classificação é consistente, então
    // a primária basta.
    vistos.add(t.fingerprint)
    novas.push(t)
  }

  return { novas, duplicadas }
}
