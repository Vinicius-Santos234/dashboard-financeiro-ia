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
import { Button } from '@/components/ui/button'

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
    <div className="flex w-full max-w-sm flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Dashboard Financeiro
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          {modo === 'entrar'
            ? 'Entre para ver seus gastos.'
            : 'Crie uma conta para começar.'}
        </p>
      </div>

      <form onSubmit={autenticar} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">E-mail</span>
          <input
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-100"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Senha</span>
          <input
            name="senha"
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'}
            required
            minLength={6}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-100"
          />
        </label>

        {erro && (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {erro}
          </p>
        )}

        <Button type="submit" disabled={ocupado}>
          {ocupado ? 'Aguarde…' : modo === 'entrar' ? 'Entrar' : 'Criar conta'}
        </Button>
      </form>

      {process.env.NEXT_PUBLIC_DEMO_EMAIL && process.env.NEXT_PUBLIC_DEMO_PASSWORD && (
        <button
          type="button"
          onClick={() => {
            setModo('entrar')
            setEmail(process.env.NEXT_PUBLIC_DEMO_EMAIL ?? '')
            setSenha(process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? '')
            setErroLocal(null)
          }}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Preencher conta demo
        </button>
      )}

      {/* Segundo formulário, invisível: leva só o ID token ao servidor. */}
      <form ref={formRef} action={enviarSessao} className="hidden">
        <input ref={tokenRef} type="hidden" name="idToken" />
        <input type="hidden" name="proximo" value={proximo} />
      </form>

      <button
        type="button"
        onClick={() => {
          setModo(modo === 'entrar' ? 'cadastrar' : 'entrar')
          setErroLocal(null)
        }}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        {modo === 'entrar' ? 'Não tenho conta' : 'Já tenho conta'}
      </button>
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
