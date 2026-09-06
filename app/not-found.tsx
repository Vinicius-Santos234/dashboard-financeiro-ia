import Link from 'next/link'
import { Marca } from '@/components/marca'

/**
 * A 404.
 *
 * Fica na raiz, e não dentro de `(app)`, de propósito: quem cai numa URL
 * errada pode não estar logado, e mostrar o cabeçalho do app com navegação
 * para telas protegidas seria oferecer portas que vão bater na cara.
 *
 * Por isso ela também não tenta adivinhar para onde a pessoa ia. Oferece dois
 * caminhos honestos — o resumo, se houver sessão, e a entrada, se não houver —
 * e o navegador resolve: quem não tiver cookie é mandado para o login pelo
 * proxy, sem passar por uma tela intermediária dizendo "acesso negado".
 */
export default function NaoEncontrada() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <Marca size={40} className="text-fraco" />

        <p className="rotulo mt-8">Erro 404</p>
        <h1 className="mt-3 font-display text-[2.75rem] leading-[1.05] tracking-tight">
          Esta página
          <br />
          não existe
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-suave">
          O endereço pode ter mudado, ou o link que trouxe você até aqui está
          incompleto.
        </p>

        <div className="mt-10 flex flex-col gap-4 border-t border-linha pt-6">
          <Link
            href="/dashboard"
            className="w-full bg-texto px-6 py-3 text-center text-sm font-medium text-fundo transition-opacity duration-300 hover:opacity-85"
          >
            Ir para o resumo
          </Link>
          <Link
            href="/login"
            className="text-center text-sm text-fraco underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-suave"
          >
            Entrar em outra conta
          </Link>
        </div>
      </div>
    </main>
  )
}
