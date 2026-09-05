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
  fingerprint: string
}

/**
 * Calcula o fingerprint de cada transação do arquivo.
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
 *    linha ser recusada pela constraint. Quando um FITID se repete dentro do
 *    arquivo, todas as linhas que o compartilham caem para o hash de conteúdo.
 */
export function atribuirFingerprints(
  accountId: string,
  transacoes: readonly RawTransaction[]
): ComFingerprint[] {
  const vezesQueOFitidAparece = new Map<string, number>()
  for (const t of transacoes) {
    if (t.fitid) {
      vezesQueOFitidAparece.set(t.fitid, (vezesQueOFitidAparece.get(t.fitid) ?? 0) + 1)
    }
  }

  const ocorrencias = new Map<string, number>()

  return transacoes.map((t) => {
    const fitidConfiavel =
      t.fitid !== undefined &&
      t.fitid !== '' &&
      vezesQueOFitidAparece.get(t.fitid) === 1

    if (fitidConfiavel) {
      return { ...t, fingerprint: fingerprintPorFitid(accountId, t.fitid!) }
    }

    const chave = [
      t.occurredOn,
      t.amountCents,
      normalizeDescription(t.description),
    ].join('|')

    const seq = ocorrencias.get(chave) ?? 0
    ocorrencias.set(chave, seq + 1)

    return {
      ...t,
      fingerprint: fingerprintPorConteudo(
        accountId,
        t.occurredOn,
        t.amountCents,
        t.description,
        seq
      ),
    }
  })
}

export interface SeparacaoDuplicadas {
  novas: ComFingerprint[]
  duplicadas: ComFingerprint[]
}

/**
 * Separa o que é novo do que já está no banco.
 *
 * `jaExistentes` vem de um `select fingerprint from transactions` — a RLS
 * garante que só volta o do próprio usuário, então não há filtro manual aqui.
 *
 * Também remove duplicata **dentro do próprio arquivo**: se o mesmo
 * fingerprint aparecer duas vezes no lote, só a primeira entra. Sem isso o
 * insert em lote estouraria na constraint e derrubaria o import inteiro por
 * causa de uma linha.
 */
export function separarDuplicadas(
  transacoes: readonly ComFingerprint[],
  jaExistentes: Iterable<string>
): SeparacaoDuplicadas {
  const vistos = new Set(jaExistentes)
  const novas: ComFingerprint[] = []
  const duplicadas: ComFingerprint[] = []

  for (const t of transacoes) {
    if (vistos.has(t.fingerprint)) {
      duplicadas.push(t)
    } else {
      vistos.add(t.fingerprint)
      novas.push(t)
    }
  }

  return { novas, duplicadas }
}
