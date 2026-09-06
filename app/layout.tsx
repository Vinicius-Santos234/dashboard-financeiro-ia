import type { Metadata } from 'next'
import { Geist, Geist_Mono, Bodoni_Moda } from 'next/font/google'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

/**
 * A serifada é o que entrega "extrato de banco privado" num segundo — e faz
 * isso sozinha, sem dourado nem ornamento.
 *
 * Bodoni: didone de alto contraste, eixo vertical, hastes longas. A primeira
 * tentativa foi Instrument Serif e ficou ACHATADA — x-height grande com hastes
 * curtas empilha baixo, e o resultado lembra o serif padrão do navegador, que
 * é justamente a sensação de HTML cru que queríamos evitar.
 *
 * Fica só em títulos e no nome do app. Os números continuam em sans com
 * `tabular-nums`: dinheiro precisa alinhar coluna a coluna, e o traço fino da
 * Bodoni sumiria em corpo pequeno sobre fundo escuro.
 */
const serifada = Bodoni_Moda({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['400', '600'],
})

export const metadata: Metadata = {
  title: 'Dashboard Financeiro',
  description:
    'Importe o extrato do seu banco e veja seus gastos categorizados por IA.',
  robots: {
    // Dados financeiros pessoais atrás de login não têm por que ser indexados.
    index: false,
    follow: false,
  },
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} ${serifada.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
