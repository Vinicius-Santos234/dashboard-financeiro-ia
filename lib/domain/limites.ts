/**
 * Tetos de uso da LLM.
 *
 * Os créditos do Gemini ficam no **projeto** e são compartilhados entre
 * desenvolvimento e produção, então o custo de um descuido é dinheiro real.
 */

/**
 * Por usuário, por dia. 40 cobre com folga o uso de uma pessoa — um import de
 * 1.000 transações são 20 lotes, e um insight é 1.
 */
export const LIMITE_LLM_DIARIO = 40

/**
 * Do projeto inteiro, por dia.
 *
 * O teto por usuário sozinho é **multiplicável**: o cadastro é aberto, então
 * quem quiser gastar os créditos cria contas — ou consome, apaga e recria. Este
 * segundo teto é o que de fato protege o orçamento, porque não depende de
 * quantas identidades existem.
 *
 * 400 = dez usuários no limite. Se um dia isso apertar por uso legítimo, é
 * sinal de que o projeto precisa de faturamento próprio, não de um número maior.
 */
export const LIMITE_LLM_GLOBAL_DIARIO = 400

/**
 * Corte da descrição enviada à LLM.
 *
 * A cota conta **chamadas**, não tokens: 20 lotes de descrições gigantes custam
 * as mesmas 20 unidades e ordens de grandeza mais dinheiro. Descrição de
 * extrato real não passa de ~60 caracteres; 140 dá folga e ainda impede que uma
 * linha inflada carregue o lote inteiro.
 */
export const MAX_CARACTERES_DESCRICAO = 140

/**
 * Teto de saída por chamada.
 *
 * A resposta é um JSON de no máximo 50 objetos curtos (id, categoria,
 * confiança). Sem limite, um modelo em laço pode gerar até o teto do modelo e
 * cobrar por isso.
 */
export const MAX_TOKENS_SAIDA = 4096
