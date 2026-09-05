'use client'

import { useActionState, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { entrar, cadastrar, type EstadoAuth } from './actions'
import { Button } from '@/components/ui/button'

const INICIAL: EstadoAuth = {}

function Formulario() {
  const [modo, setModo] = useState<'entrar' | 'cadastrar'>('entrar')
  const acao = modo === 'entrar' ? entrar : cadastrar
  const [estado, enviar, pendente] = useActionState(acao, INICIAL)
  const proximo = useSearchParams().get('proximo') ?? ''

  return (
    <form action={enviar} className="flex w-full max-w-sm flex-col gap-4">
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

      <input type="hidden" name="proximo" value={proximo} />

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">E-mail</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={estado.email}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-100"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Senha</span>
        <input
          name="senha"
          type="password"
          autoComplete={
            modo === 'entrar' ? 'current-password' : 'new-password'
          }
          required
          minLength={8}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-100"
        />
      </label>

      {estado.erro && (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {estado.erro}
        </p>
      )}

      <Button type="submit" disabled={pendente}>
        {pendente
          ? 'Aguarde…'
          : modo === 'entrar'
            ? 'Entrar'
            : 'Criar conta'}
      </Button>

      <button
        type="button"
        onClick={() => setModo(modo === 'entrar' ? 'cadastrar' : 'entrar')}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        {modo === 'entrar'
          ? 'Não tenho conta'
          : 'Já tenho conta'}
      </button>
    </form>
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
