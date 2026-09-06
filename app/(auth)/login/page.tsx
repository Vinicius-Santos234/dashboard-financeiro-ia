'use client'

import { Suspense, useActionState, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  setPersistence,
  inMemoryPersistence,
  signOut,
  type AuthError,
} from 'firebase/auth'
import { auth } from '@/lib/firebase/client'
import { abrirSessao, type EstadoAuth } from './actions'
import { Marca } from '@/components/marca'

const INICIAL: EstadoAuth = {}

/**
 * As mensagens do Firebase são códigos em inglês. Traduzir aqui evita mostrar
 * `auth/invalid-credential` para quem só errou a senha — e mantém a mensagem
 * genérica, porque dizer "este e-mail não existe" entrega quais contas existem.
 */
function mensagem(codigo: string): string {
  switch (codigo) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'E-mail ou senha incorretos.'
    case 'auth/email-already-in-use':
      return 'Já existe uma conta com este e-mail.'
    case 'auth/weak-password':
      return 'A senha precisa de pelo menos 6 caracteres.'
    case 'auth/invalid-email':
      return 'E-mail inválido.'
    case 'auth/too-many-requests':
      return 'Muitas tentativas. Espere um pouco e tente de novo.'
    case 'auth/network-request-failed':
      return 'Sem conexão com o servidor de autenticação.'
    default:
      return 'Não foi possível entrar. Tente de novo.'
  }
}

function Formulario() {
  const [modo, setModo] = useState<'entrar' | 'cadastrar'>('entrar')
  const [erroLocal, setErroLocal] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [estado, enviarSessao] = useActionState(abrirSessao, INICIAL)

  const formRef = useRef<HTMLFormElement>(null)
  const tokenRef = useRef<HTMLInputElement>(null)
  const proximo = useSearchParams().get('proximo') ?? ''

  async function autenticar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErroLocal(null)
    setOcupado(true)

    const dados = new FormData(e.currentTarget)
    const email = String(dados.get('email') ?? '')
    const senha = String(dados.get('senha') ?? '')

    try {
      // Sessão do SDK cliente só na memória desta aba: sem isto, o refresh
      // token fica em IndexedDB e sobrevive ao fechamento do navegador.
      await setPersistence(auth, inMemoryPersistence)

      const cred =
        modo === 'entrar'
          ? await signInWithEmailAndPassword(auth, email, senha)
          : await createUserWithEmailAndPassword(auth, email, senha)

      // O ID token vai para a Server Action, que o troca por cookie httpOnly.
      const idToken = await cred.user.getIdToken()

      // E então DESLOGA do SDK cliente, de propósito.
      //
      // Isto fecha um buraco crítico: enquanto existe `auth.currentUser`, o
      // Firebase Auth permite que a própria pessoa chame `deleteUser()` ou
      // `updatePassword()` pelo console do navegador — e isso não passa por
      // nenhuma rota nossa, então `exigirSessaoGravavel` não vê. Na conta demo
      // pública, qualquer visitante apagaria ou sequestraria a identidade da
      // demonstração; trocando o e-mail, deixaria até de ser reconhecido como
      // demo.
      //
      // Dá para desligar porque o app **não usa o SDK cliente depois do
      // login**: as telas são Server Components e as rotas leem a sessão do
      // cookie httpOnly. Quem manda no acesso é o cookie, não o `currentUser`.
      await signOut(auth)

      if (tokenRef.current) tokenRef.current.value = idToken
      formRef.current?.requestSubmit()
    } catch (erro) {
      setErroLocal(mensagem((erro as AuthError).code ?? ''))
      setOcupado(false)
    }
  }

  const erro = erroLocal ?? estado.erro

  return (
    <div className="flex w-full max-w-sm flex-col gap-10">
      <div>
        <Marca size={36} className="mb-8 text-suave" />
        <p className="rotulo">Finanças pessoais</p>
        <h1 className="mt-3 font-display text-[2.75rem] leading-[1.05] tracking-tight">
          Dashboard
          <br />
          Financeiro
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-suave">
          {modo === 'entrar'
            ? 'Importe o extrato do seu banco e veja para onde o dinheiro foi.'
            : 'Crie uma conta para começar a acompanhar seus gastos.'}
        </p>
      </div>

      <form onSubmit={autenticar} className="flex flex-col gap-6">
        <label className="flex flex-col gap-2">
          <span className="rotulo">E-mail</span>
          <input
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            // Campo como linha, não como caixa: sublinhado que acende ao focar.
            // Caixa com borda nos quatro lados é o que faz um formulário
            // parecer cadastro de sistema interno.
            className="border-b border-linha-forte bg-transparent py-2 text-sm outline-none transition-colors duration-300 focus:border-texto"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="rotulo">Senha</span>
          <input
            name="senha"
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'}
            required
            minLength={6}
            className="border-b border-linha-forte bg-transparent py-2 text-sm outline-none transition-colors duration-300 focus:border-texto"
          />
        </label>

        {erro && (
          <p role="alert" className="text-sm" style={{ color: 'var(--alarme)' }}>
            {erro}
          </p>
        )}

        <button
          type="submit"
          disabled={ocupado}
          className="mt-2 w-full bg-texto px-6 py-3 text-sm font-medium text-fundo transition-opacity duration-300 hover:opacity-85 disabled:opacity-40"
        >
          {ocupado ? 'Aguarde…' : modo === 'entrar' ? 'Entrar' : 'Criar conta'}
        </button>
      </form>

      <div className="flex flex-col gap-4 border-t border-linha pt-6">
        {process.env.NEXT_PUBLIC_DEMO_EMAIL && process.env.NEXT_PUBLIC_DEMO_PASSWORD && (
          <button
            type="button"
            onClick={() => {
              setModo('entrar')
              setEmail(process.env.NEXT_PUBLIC_DEMO_EMAIL ?? '')
              setSenha(process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? '')
              setErroLocal(null)
            }}
            className="w-full border border-linha-forte px-6 py-3 text-sm text-suave transition-colors duration-300 hover:border-texto hover:text-texto"
          >
            Entrar na demonstração
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            setModo(modo === 'entrar' ? 'cadastrar' : 'entrar')
            setErroLocal(null)
          }}
          className="text-sm text-fraco underline decoration-linha-forte underline-offset-4 transition-colors duration-300 hover:text-suave"
        >
          {modo === 'entrar' ? 'Não tenho conta' : 'Já tenho conta'}
        </button>
      </div>

      {/* Segundo formulário, invisível: leva só o ID token ao servidor. */}
      <form ref={formRef} action={enviarSessao} className="hidden">
        <input ref={tokenRef} type="hidden" name="idToken" />
        <input type="hidden" name="proximo" value={proximo} />
      </form>
    </div>
  )
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Suspense>
        <Formulario />
      </Suspense>
    </main>
  )
}
