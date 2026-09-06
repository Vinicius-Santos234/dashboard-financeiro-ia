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

/**
 * Cor por categoria. Definida aqui para pizza, legenda e badge não divergirem.
 *
 * **Esta é a única cor do app.** A interface é monocromática quente de
 * propósito (ver `app/globals.css`), então nada compete com estes dez tons — e
 * é por isso que eles ficam legíveis mesmo sendo discretos.
 *
 * Refeitos para fundo escuro. A paleta anterior tinha sido escolhida para
 * fundo claro e embarrava sobre o carvão: cor saturada sobre escuro vira neon,
 * e cor clara demais some. O ponto de equilíbrio são **tons de joia
 * dessaturados**, todos numa faixa de luminosidade parecida — assim nenhuma
 * fatia da pizza grita mais alto que as outras, e o conjunto lê como uma
 * paleta e não como dez cores soltas.
 */
export const CATEGORIA_COR: Record<Categoria, string> = {
  alimentacao: '#d98b5f', // terracota
  transporte: '#7ba3c9', // azul empoeirado
  moradia: '#a68bc4', // violeta suave
  saude: '#6fb3a3', // verde-água
  lazer: '#d4b072', // ocre
  educacao: '#8296c9', // pervinca
  compras: '#c98aa4', // rosa antigo
  contas_fixas: '#8a9199', // ardósia
  receita: '#7fb884', // sálvia — a mesma do token `--entrada`
  outros: '#6e6862', // cinza quente
}
