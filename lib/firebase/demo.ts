import 'server-only'
import { adminAuth } from './admin'

/** A identidade é escolhida apenas pela configuração do servidor. */
export async function contaDemo() {
  const uid = process.env.FIREBASE_DEMO_UID?.trim()
  const email = process.env.NEXT_PUBLIC_DEMO_EMAIL?.trim()
  if (!uid && !email) throw new Error('Demonstração não configurada.')
  const usuario = uid
    ? await adminAuth().getUser(uid)
    : await adminAuth().getUserByEmail(email!)

  // Não habilita o novo acesso enquanto a senha pública antiga ainda funciona.
  if (!usuario.disabled) {
    throw new Error('Execute npm run migrar:demo antes de abrir a demonstração.')
  }
  return { uid: usuario.uid, email: usuario.email ?? null, demo: true as const }
}
