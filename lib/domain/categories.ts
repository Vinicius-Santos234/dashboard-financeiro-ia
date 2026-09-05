/**
 * As dez categorias. Spec §3 D6 e §4.1.
 *
 * Fechadas de propósito: categoria livre faz o mesmo gasto virar "Comida",
 * "Alimentação" e "Delivery" em meses diferentes, e aí a comparação mês a mês
 * — que é metade do valor do dashboard — deixa de existir.
 *
 * Esta lista é a fonte única: o enum do Postgres (migration 0001), o
 * `responseSchema` do Gemini (§6.2) e o filtro da UI saem todos daqui.
 */
export const CATEGORIAS = [
  'alimentacao',
  'transporte',
  'moradia',
  'saude',
  'lazer',
  'educacao',
  'compras',
  'contas_fixas',
  'receita',
  'outros',
] as const

export type Categoria = (typeof CATEGORIAS)[number]

export const CATEGORIA_LABEL: Record<Categoria, string> = {
  alimentacao: 'Alimentação',
  transporte: 'Transporte',
  moradia: 'Moradia',
  saude: 'Saúde',
  lazer: 'Lazer',
  educacao: 'Educação',
  compras: 'Compras',
  contas_fixas: 'Contas fixas',
  receita: 'Receita',
  outros: 'Outros',
}

/**
 * Descrição enviada à LLM junto do prompt. Existe para reduzir a taxa de
 * `outros`, que é a métrica de qualidade da E4 (§9) — quanto mais claro o
 * limite entre duas categorias, menos o modelo escorrega para o escape.
 */
export const CATEGORIA_CRITERIO: Record<Categoria, string> = {
  alimentacao: 'mercado, padaria, restaurante, delivery, lanchonete, açougue',
  transporte: 'combustível, app de corrida, transporte público, estacionamento, pedágio, manutenção do carro',
  moradia: 'aluguel, condomínio, IPTU, reforma, móveis, itens de casa',
  saude: 'farmácia, consulta, exame, plano de saúde, academia, terapia',
  lazer: 'streaming, cinema, bar, viagem, jogos, evento, hobby',
  educacao: 'mensalidade, curso, livro, material escolar, certificação',
  compras: 'roupa, eletrônico, presente, e-commerce genérico sem categoria mais específica',
  contas_fixas: 'luz, água, gás, internet, telefone, assinatura recorrente de serviço essencial',
  receita: 'salário, pagamento recebido, reembolso, rendimento, qualquer entrada de dinheiro',
  outros: 'só quando a descrição não permite decidir — transferência sem contexto, PIX sem identificação, taxa bancária genérica',
}

export function isCategoria(v: unknown): v is Categoria {
  return typeof v === 'string' && (CATEGORIAS as readonly string[]).includes(v)
}

/** Cor por categoria. Definida aqui para pizza, legenda e badge não divergirem. */
export const CATEGORIA_COR: Record<Categoria, string> = {
  alimentacao: '#e8734a',
  transporte: '#4a90d9',
  moradia: '#8b6bb1',
  saude: '#3fa796',
  lazer: '#e0a33e',
  educacao: '#5c7cbb',
  compras: '#c25e8a',
  contas_fixas: '#6b7a8f',
  receita: '#4aa564',
  outros: '#9aa0a6',
}
