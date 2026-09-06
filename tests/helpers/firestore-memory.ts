/** Banco em memória para exercitar o repositório sem credenciais ou rede.
 * As escritas de uma transação só são publicadas depois do callback concluir. */
type Dados = Record<string, unknown>
export const documentos = new Map<string, Dados>()
let sequencia = 0

export function limparBanco() {
  documentos.clear()
  sequencia = 0
}

export function doc(path: string) {
  return {
    path, id: path.split('/').at(-1)!,
    get: async () => snapshot(path),
    set: async (dados: Dados, opcoes?: { merge?: boolean }) => {
      documentos.set(path, { ...(opcoes?.merge ? documentos.get(path) : {}), ...dados })
    },
    update: async (dados: Dados) => {
      if (!documentos.has(path)) throw new Error('Documento inexistente')
      documentos.set(path, { ...documentos.get(path), ...dados })
    },
  }
}

function snapshot(path: string) {
  const dados = documentos.get(path)
  return { ref: doc(path), id: path.split('/').at(-1)!, exists: Boolean(dados), data: () => dados }
}

function collection(path: string, filtros: Array<[string, unknown]> = []) {
  return {
    doc: (id?: string) => doc(`${path}/${id ?? `id_${++sequencia}`}`),
    where: (campo: string, operador: string, valor: unknown) => {
      if (operador !== '==') throw new Error('Operador não suportado pelo teste')
      return collection(path, [...filtros, [campo, valor]])
    },
    orderBy: () => collection(path, filtros),
    get: async () => ({ docs: [...documentos.keys()]
      .filter((key) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/'))
      .filter((key) => filtros.every(([campo, valor]) => documentos.get(key)?.[campo] === valor))
      .map(snapshot) }),
  }
}

type Referencia = ReturnType<typeof doc>
function transacao() {
  const operacoes: Array<() => Promise<void>> = []
  function exigirLeiturasPrimeiro() {
    if (operacoes.length) throw new Error('Leitura após escrita na transação')
  }
  return {
    get: async (ref: Referencia) => { exigirLeiturasPrimeiro(); return snapshot(ref.path) },
    getAll: async (...refs: Referencia[]) => {
      exigirLeiturasPrimeiro()
      return refs.map((ref) => snapshot(ref.path))
    },
    create: (ref: Referencia, dados: Dados) => {
      if (documentos.has(ref.path)) throw new Error('Documento duplicado')
      operacoes.push(() => ref.set(dados))
    },
    update: (ref: Referencia, dados: Dados) => { operacoes.push(() => ref.update(dados)) },
    set: (ref: Referencia, dados: Dados) => { operacoes.push(() => ref.set(dados)) },
    commit: async () => { for (const operacao of operacoes) await operacao() },
  }
}

export const banco = {
  doc, collection,
  getAll: async (...refs: Referencia[]) => refs.map((ref) => snapshot(ref.path)),
  runTransaction: async <T>(fn: (tx: ReturnType<typeof transacao>) => Promise<T>) => {
    const tx = transacao()
    const resultado = await fn(tx)
    await tx.commit()
    return resultado
  },
}
