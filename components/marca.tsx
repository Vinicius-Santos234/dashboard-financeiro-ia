/**
 * A marca, inline.
 *
 * Precisa ser inline, e não `<Image src="/marca.svg">`: o `next/image` serve o
 * arquivo como `<img>`, e um `<img>` é um documento isolado — o `currentColor`
 * de dentro dele não enxerga a cor do texto ao lado. Inline, o SVG faz parte
 * do documento e herda.
 *
 * Isso importa porque o sistema não usa branco puro em lugar nenhum: a marca
 * tem que ficar no mesmo creme do texto, e escurecer junto no `hover`. Com
 * `<img>` ela ficaria sempre mais brilhante que a palavra ao lado.
 */
export function Marca({
  size = 26,
  className,
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      aria-hidden
      className={className}
    >
      {/* Moeda de fundo, deslocada */}
      <circle cx="70" cy="130" r="42" strokeWidth="6" opacity="0.5" />
      {/* Moeda principal */}
      <circle cx="120" cy="80" r="58" strokeWidth="7" />
      <circle cx="120" cy="80" r="46" strokeWidth="2.5" opacity="0.65" />
      {/* Seta de crescimento */}
      <path
        d="M112 168 L138 142 L152 156 L182 122"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M160 118 L184 120 L182 144"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="70"
        y="140"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="34"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
        textAnchor="middle"
        opacity="0.5"
      >
        $
      </text>
      <text
        x="120"
        y="94"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="52"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
        textAnchor="middle"
      >
        $
      </text>
    </svg>
  )
}
