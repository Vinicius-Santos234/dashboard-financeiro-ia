/**
 * A conta demo é pública e somente-leitura.
 *
 * O link do portfólio está aberto na internet e a tela de login preenche as
 * credenciais com um clique. Sem isto, qualquer visitante poderia:
 *
 * - apagar a conta demo em `/conta` (o `recursiveDelete` é irreversível, e o
 *   demo deixaria de existir para todo mundo depois);
 * - importar um arquivo qualquer, sujando o que o próximo visitante vê;
 * - disparar categorização e insights, **queimando os créditos do Gemini** —
 *   que ficam no projeto e são os mesmos usados em desenvolvimento.
 *
 * A comparação é por e-mail e vem da sessão **verificada** (assinatura do
 * cookie conferida pelo Admin SDK), não de nada que o cliente informe.
 */

export class ContaDemoError extends Error {
  constructor(acao = 'Esta ação') {
    super(`${acao} não está disponível na conta de demonstração.`)
    this.name = 'ContaDemoError'
  }
}

export function ehEmailDemo(email: string | null | undefined): boolean {
  const demo = process.env.NEXT_PUBLIC_DEMO_EMAIL?.trim().toLowerCase()
  if (!demo) return false
  return (email ?? '').trim().toLowerCase() === demo
}
