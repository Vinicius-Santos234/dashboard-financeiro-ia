import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth, type Auth } from 'firebase-admin/auth'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

/**
 * SDK de servidor.
 *
 * AVISO QUE PRECISA FICAR AQUI: este SDK ignora as Security Rules. Tudo que
 * ele toca passa por cima de firestore.rules. A proteção do lado servidor é a
 * árvore de caminhos em lib/firestore/paths.ts — leia o comentário de lá antes
 * de escrever qualquer acesso novo.
 *
 * **A inicialização é preguiçosa de propósito.** A versão anterior criava o
 * app em tempo de módulo, e isso quebrava o `next build`: ao coletar dados das
 * páginas, o Next avalia os módulos, o app tentava ler as credenciais e o
 * build falhava com "Failed to collect page data for /importar". A saída fácil
 * seria injetar credencial falsa no CI; a certa é **build não exigir segredo
 * de runtime** — ele não abre conexão com nada, então não tem por que precisar
 * de chave.
 *
 * O efeito colateral bom: em desenvolvimento, um `.env.local` incompleto
 * derruba só a rota que realmente usa o banco, com a mensagem certa, em vez de
 * impedir o servidor de subir.
 */

const NOME = 'admin'

function inicializar(): App {
  const existente = getApps().find((a) => a.name === NOME)
  if (existente) return existente

  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Faltam FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL ou FIREBASE_PRIVATE_KEY. ' +
        'Veja .env.local.example.'
    )
  }

  return initializeApp(
    {
      credential: cert({
        projectId,
        clientEmail,
        // A chave vem do JSON com \n literais. Em variável de ambiente isso
        // vira a sequência de dois caracteres, e o cert() precisa da quebra de
        // linha de verdade.
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    },
    NOME
  )
}

export function adminApp(): App {
  return getApps().some((a) => a.name === NOME) ? getApp(NOME) : inicializar()
}

export function adminAuth(): Auth {
  return getAuth(adminApp())
}

export function adminDb(): Firestore {
  return getFirestore(adminApp())
}
