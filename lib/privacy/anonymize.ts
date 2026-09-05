/**
 * Remove identificadores que não são necessários para categorizar uma compra.
 *
 * A função é deliberadamente pura: ela pode ser usada no import e novamente na
 * fronteira da LLM. Essa segunda aplicação protege dados importados por versões
 * antigas do app, quando `descriptionClean` ainda continha o texto original.
 */

const OPERACAO_COM_CONTRAPARTE =
  /\b(PIX\s+(?:ENVIADO|RECEBIDO)|TED|DOC|TRANSFER[EÊ]NCIA)\b[\s:;\-–—|]*(?:.*)$/iu

const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/gu
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/gu
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu
const TELEFONE = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[-.\s]?\d{4}\b/gu
const AGENCIA = /\bAG(?:[EÊ]NCIA)?\s*[:.-]?\s*\d{4,}\b/giu
const CONTA = /\bC\s*\/?\s*C\s*[:.-]?\s*[\d.-]+\b/giu
const SEQUENCIA_LONGA = /\d{6,}/gu

export function anonymize(descricao: string): string {
  let limpa = descricao.normalize('NFC')

  // A contraparte costuma vir no restante da linha. Manter somente o nome da
  // operação retém o pouco contexto categórico existente sem enviar a pessoa.
  limpa = limpa.replace(OPERACAO_COM_CONTRAPARTE, '$1')

  limpa = limpa
    .replace(EMAIL, ' ')
    .replace(UUID, ' ')
    .replace(CNPJ, ' ')
    .replace(CPF, ' ')
    .replace(SEQUENCIA_LONGA, ' ')
    .replace(TELEFONE, ' ')
    .replace(AGENCIA, ' ')
    .replace(CONTA, ' ')
    .replace(/[\s|;,:\-–—]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()

  return limpa || 'DADO REMOVIDO'
}
