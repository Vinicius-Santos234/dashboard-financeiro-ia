'use client'

import { Suspense, useActionState, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
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
      const cred =
        modo === 'entrar'
          ? await signInWithEmailAndPassword(auth, email, senha)
          : await createUserWithEmailAndPassword(auth, email, senha)

      // O ID token vai para a Server Action, que o troca por cookie httpOnly.
      // O token em si não fica em lugar nenhum que um script possa ler depois.
      const idToken = await cred.user.getIdToken()
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
