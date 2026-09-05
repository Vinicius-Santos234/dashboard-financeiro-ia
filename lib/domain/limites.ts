/**
 * Teto diario de chamadas a LLM por usuario.
 *
 * Os creditos do Gemini ficam no PROJETO e sao compartilhados entre
 * desenvolvimento e producao. 40 chamadas cobrem com folga o uso real de uma
 * pessoa (um import de 1000 transacoes sao 20 lotes, e um insight e 1) e
 * impedem que um laco acidental consuma o que foi pago.
 */
export const LIMITE_LLM_DIARIO = 40
