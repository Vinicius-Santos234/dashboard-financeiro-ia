import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

/**
 * SDK de servidor.
 *
 * AVISO QUE PRECISA FICAR AQUI: este SDK ignora as Security Rules. Tudo que
 * ele toca passa por cima de firestore.rules. A protecao do lado servidor e a
 * arvore de caminhos em lib/firestore/paths.ts — leia o comentario de la antes
 * de escrever qualquer acesso novo.
 */
function credencial(): App {
  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Faltam FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL ou FIREBASE_PRIVATE_KEY. ' +
        'Veja .env.local.example.'
    )
  }

  return initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      // A chave vem do JSON com \n literais. Em env var isso vira a sequencia
      // de dois caracteres, e o cert() precisa da quebra de linha de verdade.
      privateKey: privateKey.replace(/\n/g, '\n'),
    }),
  })
}

export const adminApp = getApps().length ? getApp() : credencial()
export const adminAuth = getAuth(adminApp)
export const adminDb = getFirestore(adminApp)
