export function mensagemPublicaLlm(erro: unknown): string {
  const mensagem = erro instanceof Error ? erro.message : String(erro)

  if (/RESOURCE_EXHAUSTED|prepayment credits|quota/i.test(mensagem)) {
    return 'A IA está temporariamente indisponível porque a cota ou os créditos do Gemini acabaram.'
  }

  if (/NOT_FOUND|model.+not.+available/i.test(mensagem)) {
    return 'O modelo de IA configurado não está disponível. Atualize GEMINI_MODEL.'
  }

  return 'Não foi possível concluir a solicitação com a IA. Tente novamente mais tarde.'
}
