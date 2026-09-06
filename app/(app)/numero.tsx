/**
 * O bloco de número grande, usado no resumo e nas transações.
 *
 * Estava duplicado nas duas telas e as cópias já tinham começado a divergir —
 * uma tinha `detalhe`, a outra não.
 *
 * O conteúdo fica **centrado verticalmente** como um grupo. A primeira versão
 * usava `justify-between`, que empurrava o rótulo para o topo e o valor para a
 * base: com altura mínima fixa, isso abria um vão morto no meio e deixava os
 * cartões parecendo desalinhados entre si — sobretudo ao lado do único que tem
 * uma linha extra embaixo.
 */
export function Numero({
  rotulo,
  valor,
  detalhe,
  entrada,
  cor,
}: {
  rotulo: string
  valor: string
  detalhe?: string
  /** Pinta de verde sálvia. Para entrada de dinheiro e saldo positivo. */
  entrada?: boolean
  /** Cor de categoria, quando o valor é o nome de uma. */
  cor?: string
}) {
  return (
    <div className="flex min-h-[8rem] flex-col justify-center bg-fundo p-6">
      <p className="rotulo">{rotulo}</p>
      <p
        className="valor mt-3 text-[1.75rem] font-light leading-none"
        style={cor ? { color: cor } : entrada ? { color: 'var(--entrada)' } : undefined}
      >
        {valor}
      </p>
      {detalhe && <p className="valor mt-2 text-xs text-fraco">{detalhe}</p>}
    </div>
  )
}
