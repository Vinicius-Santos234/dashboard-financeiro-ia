import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { config } from 'dotenv'
import { adminAuth, adminDb } from '../lib/firebase/admin'

const arquivoEnv = process.argv.find((arg) => arg.startsWith('--env-file='))?.slice('--env-file='.length)
config({ path: arquivoEnv ?? '.env.local', quiet: true })
const credencial = process.argv.find((arg) => arg.startsWith('--credential='))?.slice('--credential='.length)
if (credencial) {
  const dados = JSON.parse(readFileSync(credencial, 'utf8'))
  process.env.FIREBASE_PROJECT_ID = dados.project_id
  process.env.FIREBASE_CLIENT_EMAIL = dados.client_email
  process.env.FIREBASE_PRIVATE_KEY = dados.private_key
}

async function main() {
  const esperado = process.argv.find((arg) => arg.startsWith('--project='))?.slice('--project='.length)
  if (esperado && process.env.FIREBASE_PROJECT_ID !== esperado) {
    throw new Error('O projeto Firebase não corresponde ao destino informado. Nenhuma alteração realizada.')
  }
  const email = process.env.NEXT_PUBLIC_DEMO_EMAIL?.trim()
  if (!email || !email.toLowerCase().includes('demo')) {
    throw new Error('Configure NEXT_PUBLIC_DEMO_EMAIL com o e-mail da demonstração.')
  }
  const usuario = await adminAuth().getUserByEmail(email)
  const uidEsperado = process.env.FIREBASE_DEMO_UID?.trim()
  if (uidEsperado && usuario.uid !== uidEsperado) {
    throw new Error('O UID configurado não corresponde à conta demo. Nenhuma alteração realizada.')
  }
  async function contagens() {
    const colecoes = ['accounts', 'transactions', 'imports', 'rules', 'rollups', 'insights']
    return Object.fromEntries(await Promise.all(colecoes.map(async (nome) => {
      const resultado = await adminDb().collection(`users/${usuario.uid}/${nome}`).count().get()
      return [nome, resultado.data().count]
    })))
  }
  const antes = await contagens()
  console.log(JSON.stringify({ projectId: process.env.FIREBASE_PROJECT_ID, uid: usuario.uid,
    email: usuario.email, disabled: usuario.disabled, documentos: antes }))
  if (process.argv.includes('--check')) return
  // Preserva todos os documentos. A identidade não precisa mais fazer login.
  await adminAuth().updateUser(usuario.uid, {
    disabled: true,
    password: randomBytes(48).toString('base64url'),
  })
  await adminAuth().revokeRefreshTokens(usuario.uid)
  const depois = await contagens()
  if (JSON.stringify(antes) !== JSON.stringify(depois)) {
    throw new Error('A contagem de documentos mudou durante a migração. Verifique antes de publicar.')
  }
  console.log('Login antigo da demo desativado; dados preservados.')
  console.log(`Configure FIREBASE_DEMO_UID=${usuario.uid} no mesmo ambiente do app.`)
}

main().catch((erro) => {
  console.error(erro instanceof Error ? erro.message : 'Falha ao migrar demo.')
  process.exitCode = 1
})
