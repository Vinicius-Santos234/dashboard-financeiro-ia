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

