import { readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

/**
 * Cria (ou reaproveita) os dois usuários que o teste de isolamento precisa.
 *
 * Rode com: npm run seed:usuarios
 *
 * São contas descartáveis do projeto de desenvolvimento. As senhas são
 * geradas aqui e gravadas no .env.local, que está fora do git.
 */

const { adminAuth } = await import('../lib/firebase/admin')

const senha = () => randomBytes(18).toString('base64url')

async function garantir(email: string, novaSenha: string) {
  try {
    const existente = await adminAuth().getUserByEmail(email)
    // Reaproveita o uid e redefine a senha, para o teste funcionar mesmo se
    // o .env.local tiver sido perdido entre uma rodada e outra.
    await adminAuth().updateUser(existente.uid, { password: novaSenha })
    return { uid: existente.uid, criado: false }
  } catch {
    const novo = await adminAuth().createUser({ email, password: novaSenha })
    return { uid: novo.uid, criado: true }
  }
}

const A_EMAIL = 'teste-a@dashboard-financeiro.local'
const B_EMAIL = 'teste-b@dashboard-financeiro.local'

const senhaA = senha()
const senhaB = senha()

const a = await garantir(A_EMAIL, senhaA)
const b = await garantir(B_EMAIL, senhaB)

let env = readFileSync('.env.local', 'utf8')
const set = (chave: string, valor: string) => {
  const linha = `${chave}=${valor}`
  env = new RegExp(`^${chave}=.*$`, 'm').test(env)
    ? env.replace(new RegExp(`^${chave}=.*$`, 'm'), linha)
    : env.trimEnd() + `\n${linha}\n`
}

set('TEST_USER_A_EMAIL', A_EMAIL)
set('TEST_USER_A_PASSWORD', senhaA)
set('TEST_USER_A_UID', a.uid)
set('TEST_USER_B_EMAIL', B_EMAIL)
set('TEST_USER_B_PASSWORD', senhaB)
set('TEST_USER_B_UID', b.uid)

writeFileSync('.env.local', env)

console.log(`A: ${A_EMAIL}  uid=${a.uid}  ${a.criado ? '(criado)' : '(reaproveitado)'}`)
console.log(`B: ${B_EMAIL}  uid=${b.uid}  ${b.criado ? '(criado)' : '(reaproveitado)'}`)
console.log('Credenciais gravadas no .env.local.')
