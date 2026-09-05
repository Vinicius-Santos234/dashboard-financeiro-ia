import { initializeApp, getApps, getApp, type FirebaseOptions } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

/**
 * SDK cliente. Estas chaves sao publicas por desenho — o Firebase nao as trata
 * como segredo. Quem protege os dados aqui sao as Security Rules
 * (firestore.rules), nao a chave.
 */
const config: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
}

export const firebaseApp = getApps().length ? getApp() : initializeApp(config)
export const auth = getAuth(firebaseApp)
export const db = getFirestore(firebaseApp)
