export function mesValido(valor: unknown): valor is string {
  return typeof valor === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(valor)
}

export function mesAtual(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date())
}

export function mesAnterior(mes: string): string {
  const [ano, numero] = mes.split('-').map(Number)
  return numero === 1
    ? `${ano - 1}-12`
    : `${ano}-${String(numero - 1).padStart(2, '0')}`
}

export function mesSeguinte(mes: string): string {
  const [ano, numero] = mes.split('-').map(Number)
  return numero === 12
    ? `${ano + 1}-01`
    : `${ano}-${String(numero + 1).padStart(2, '0')}`
}

export function mesLegivel(mes: string): string {
  const [ano, numero] = mes.split('-').map(Number)
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(ano, numero - 1, 15))
  )
}

/**
 * `2026-08` → `ago/26`. Para cabeçalho de coluna e rótulo de barra.
 *
 * Existe porque cortar `mesLegivel` por número de caracteres produz recorte
 * arbitrário: `agosto de 2026` virava **`agosto/2`**, que se lê como um ano
 * quebrado, enquanto `maio de 2026` virava `maio/202`. Rótulo de série
 * precisa ter a mesma forma em todas as colunas, senão a comparação — que é
 * a única coisa que a tabela existe para permitir — fica difícil de varrer.
 */
export function mesCurto(mes: string): string {
  const [ano, numero] = mes.split('-').map(Number)
  const nome = new Intl.DateTimeFormat('pt-BR', { month: 'short' })
    .format(new Date(Date.UTC(ano, numero - 1, 15)))
    .replace('.', '')
  return `${nome}/${String(ano).slice(2)}`
}

