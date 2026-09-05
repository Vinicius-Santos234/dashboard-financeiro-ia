import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * O critério de aceite da E1 (spec §8).
 *
 * "Com dois usuários criados, um `select * from transactions` autenticado como
 *  A não retorna nenhuma linha de B. Provado por teste de integração, não por
 *  inspeção."
 *
 * Este teste é a razão de a RLS ser o mecanismo escolhido em vez de um `if`
 * no backend: um `if` esquecido em uma tela nova não quebra teste nenhum.
 * Uma policy removida quebra este aqui.
 */

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const A_EMAIL = process.env.TEST_USER_A_EMAIL
const A_SENHA = process.env.TEST_USER_A_PASSWORD
const B_EMAIL = process.env.TEST_USER_B_EMAIL
const B_SENHA = process.env.TEST_USER_B_PASSWORD

const configurado = Boolean(URL && KEY && A_EMAIL && A_SENHA && B_EMAIL && B_SENHA)

async function entrar(email: string, senha: string): Promise<SupabaseClient> {
  const client = createClient(URL!, KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password: senha })
  if (error) throw new Error(`Login falhou para ${email}: ${error.message}`)
  return client
}

describe.skipIf(!configurado)('RLS — isolamento por usuário', () => {
  let clienteA: SupabaseClient
  let clienteB: SupabaseClient
  let userA: string
  let userB: string
  let contaB: string

  beforeAll(async () => {
    clienteA = await entrar(A_EMAIL!, A_SENHA!)
    clienteB = await entrar(B_EMAIL!, B_SENHA!)

    userA = (await clienteA.auth.getUser()).data.user!.id
    userB = (await clienteB.auth.getUser()).data.user!.id
    expect(userA).not.toBe(userB)

    // B cria uma conta e uma transação que A nunca deveria ver.
    const { data: conta, error: erroConta } = await clienteB
      .from('accounts')
      .insert({ user_id: userB, name: 'Conta do B', kind: 'checking' })
      .select('id')
      .single()
    if (erroConta) throw new Error(`Insert de B falhou: ${erroConta.message}`)
    contaB = conta!.id

    const { error: erroTx } = await clienteB.from('transactions').insert({
      user_id: userB,
      account_id: contaB,
      occurred_on: '2026-08-14',
      amount_cents: -4790,
      description_raw: 'SEGREDO DO B',
      description_clean: 'SEGREDO DO B',
      fingerprint: `teste-rls-${userB}`,
    })
    if (erroTx) throw new Error(`Insert de transação de B falhou: ${erroTx.message}`)
  })

  it('A não lê nenhuma linha de B', async () => {
    const { data, error } = await clienteA.from('transactions').select('*')
    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(data!.every((linha) => linha.user_id === userA)).toBe(true)
    expect(data!.some((l) => l.description_raw === 'SEGREDO DO B')).toBe(false)
  })

  it('A não lê as contas de B', async () => {
    const { data } = await clienteA.from('accounts').select('*')
    expect(data!.some((c) => c.id === contaB)).toBe(false)
  })

  it('A não consegue ler a linha de B nem pedindo pelo id', async () => {
    const { data } = await clienteA
      .from('accounts')
      .select('*')
      .eq('id', contaB)
    expect(data).toEqual([])
  })

  // Este é o que só o `with check` pega. Sem ele, o insert abaixo passa: a
  // policy de leitura continua correta e o buraco fica invisível na UI.
  it('A não consegue INSERIR uma linha em nome de B', async () => {
    const { error } = await clienteA.from('accounts').insert({
      user_id: userB,
      name: 'Conta plantada por A',
      kind: 'checking',
    })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/row-level security/i)
  })

  it('A não consegue mudar o dono de uma linha própria para B', async () => {
    const { data: minha } = await clienteA
      .from('accounts')
      .insert({ user_id: userA, name: 'Conta do A', kind: 'checking' })
      .select('id')
      .single()

    const { error } = await clienteA
      .from('accounts')
      .update({ user_id: userB })
      .eq('id', minha!.id)

    expect(error).not.toBeNull()

    await clienteA.from('accounts').delete().eq('id', minha!.id)
  })

  it('quem não fez login não lê nada', async () => {
    const anonimo = createClient(URL!, KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data } = await anonimo.from('transactions').select('*')
    expect(data ?? []).toEqual([])
  })
})

describe.skipIf(configurado)('RLS — configuração ausente', () => {
  it('avisa em vez de passar em silêncio', () => {
    // Uma suíte que passa porque não rodou é pior que uma que falha.
    console.warn(
      '\n[rls.test.ts] PULADO: faltam variáveis em .env.local ' +
        '(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, ' +
        'TEST_USER_A_*, TEST_USER_B_*). O critério de aceite da E1 NÃO foi provado.\n'
    )
    expect(configurado).toBe(false)
  })
})
