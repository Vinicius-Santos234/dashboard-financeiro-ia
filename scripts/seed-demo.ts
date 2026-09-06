import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

const email = process.env.NEXT_PUBLIC_DEMO_EMAIL
if (!email) {
  throw new Error(
    'Defina NEXT_PUBLIC_DEMO_EMAIL no .env.local antes de gerar o demo.'
  )
}
if (!email.toLowerCase().includes('demo')) {
  throw new Error('Por segurança, NEXT_PUBLIC_DEMO_EMAIL precisa conter a palavra "demo".')
}

function categoriaDe(descricao: string, valor: number) {
  const texto = descricao.toUpperCase()
  if (valor >= 0) return 'receita' as const
  if (/IFOOD|CAFE|CAFETERIA|PADARIA|MERCADO|RESTAURANTE/.test(texto)) return 'alimentacao' as const
  if (/UBER|99APP|COMBUSTIVEL|POSTO/.test(texto)) return 'transporte' as const
  if (/ALUGUEL|CONDOMINIO|IPTU/.test(texto)) return 'moradia' as const
  if (/FARMACIA|CLINICA|ACADEMIA/.test(texto)) return 'saude' as const
  return 'outros' as const
}

function moverParaMes(data: string, mes: string): string {
  const dia = Math.min(Number(data.slice(8, 10)), 28)
  return `${mes}-${String(dia).padStart(2, '0')}`
}

async function main() {
  const { adminAuth } = await import('../lib/firebase/admin')
  const {
    apagarTudoDoUsuario,
    aplicarCategorias,
    criarConta,
    garantirUsuario,
    gravarTransacoes,
    registrarImport,
  } = await import('../lib/firestore/repo')
  const { ofxAdapter } = await import('../lib/sources/ofx')
  const { atribuirFingerprints } = await import('../lib/domain/fingerprint')
  const { anonymize } = await import('../lib/privacy/anonymize')
  const { mesAnterior, mesAtual } = await import('../lib/domain/month')

  async function garantirDemo() {
    try {
      const existente = await adminAuth().getUserByEmail(email!)
      if (process.env.FIREBASE_DEMO_UID && existente.uid !== process.env.FIREBASE_DEMO_UID) {
        throw new Error('FIREBASE_DEMO_UID não corresponde à conta demo.')
      }
      await adminAuth().updateUser(existente.uid, {
        disabled: true, password: randomBytes(48).toString('base64url'),
      })
      await adminAuth().revokeRefreshTokens(existente.uid)
      return existente.uid
    } catch (erro) {
      if ((erro as { code?: string }).code !== 'auth/user-not-found') throw erro
      return (await adminAuth().createUser({
        email, disabled: true, password: randomBytes(48).toString('base64url'),
      })).uid
    }
  }

  const fixturePath = resolve('tests', 'fixtures', 'derivadas', 'conta-corrente.ofx')
  const buffer = readFileSync(fixturePath)
  const parsed = await ofxAdapter.parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    undefined
  )

  const uid = await garantirDemo()
  await apagarTudoDoUsuario(uid)
  await garantirUsuario(uid, email!)
  const accountId = await criarConta(uid, {
    name: 'Conta demonstração',
    institution: 'Banco Exemplo',
    kind: 'checking',
  })

  const meses = [
    { month: mesAnterior(mesAtual()), factor: 0.74 },
    { month: mesAtual(), factor: 0.83 },
  ]

  for (const { month, factor } of meses) {
    const derivadas = parsed.transactions.map((transacao, indice) => ({
      ...transacao,
      occurredOn: moverParaMes(transacao.occurredOn, month),
      amountCents: Math.round(transacao.amountCents * factor),
      description: anonymize(transacao.description),
      fitid: `demo-${month}-${transacao.fitid ?? indice}`,
    }))
    const comFingerprint = atribuirFingerprints(accountId, derivadas)
    const importId = await registrarImport(uid, {
      accountId,
      source: 'ofx',
      filename: `extrato-demo-${month}.ofx`,
      fileHash: createHash('sha256').update(`demo-${month}`).digest('hex'),
      periodStart: `${month}-01`,
      periodEnd: `${month}-28`,
      rowsTotal: derivadas.length,
      rowsImported: derivadas.length,
      rowsDuplicated: 0,
      rowsDiscarded: 0,
      status: 'categorized',
      error: null,
    })

    await gravarTransacoes(uid, comFingerprint, {
      accountId,
      importId,
      source: 'ofx',
      descriptionClean: (transacao) => anonymize(transacao.description),
    })
    await aplicarCategorias(
      uid,
      comFingerprint.map((transacao) => ({
        fingerprint: transacao.fingerprint,
        month,
        category: categoriaDe(transacao.description, transacao.amountCents),
        categorySource: 'user' as const,
        confidence: null,
        descriptionClean: anonymize(transacao.description),
      }))
    )
  }

  console.log(`Conta demo pronta: ${email}`)
  console.log(`FIREBASE_DEMO_UID=${uid}`)
  console.log('Foram criados dois meses de dados derivados e anonimizados.')
}

main().catch((erro) => {
  console.error(erro)
  process.exitCode = 1
})
