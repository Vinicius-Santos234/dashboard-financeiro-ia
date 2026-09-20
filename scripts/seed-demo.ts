import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { config } from 'dotenv'
import type { FlowType } from '../lib/domain/financial-flow'

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

/**
 * A categoria de cada linha da fatura demo. Spec 003 §8 C1.
 *
 * O demo é a primeira coisa que um estranho vê, e a promessa da spec é que ele
 * entenda **no que a fatura foi gasta** em menos de 30 segundos. Uma fatura
 * onde metade das linhas caiu em `outros` não cumpre isso — por isso a
 * cobertura aqui é deliberadamente larga, e o alvo da §9 (≥ 90% fora de
 * `outros`) é conferido no fim do seed.
 *
 * Isto **não** é o categorizador do app: é o gabarito do demo, escrito à mão
 * para o seed não depender de uma chamada paga ao Gemini para publicar.
 */
function categoriaDe(descricao: string, flowType: FlowType) {
  // Transferência não tem categoria de gasto, e pagamento de fatura é
  // transferência: contá-lo como despesa somaria a fatura inteira por cima das
  // compras que ela paga.
  if (flowType === 'transfer') return 'outros' as const
  if (flowType === 'income') return 'receita' as const

  const texto = descricao.toUpperCase()
  if (/IFOOD|CAFE|CAFETERIA|PADARIA|MERCADO|RESTAURANTE|EXTRA/.test(texto)) return 'alimentacao' as const
  if (/UBER|99APP|99POP|COMBUSTIVEL|POSTO|IPIRANGA/.test(texto)) return 'transporte' as const
  if (/ALUGUEL|CONDOMINIO|IPTU/.test(texto)) return 'moradia' as const
  if (/FARMACIA|DROGARIA|CLINICA|ACADEMIA|SMARTFIT/.test(texto)) return 'saude' as const
  if (/NETFLIX|SPOTIFY|CINEMA|INGRESSO|STREAMING/.test(texto)) return 'lazer' as const
  if (/UDEMY|CURSO|ESCOLA|FACULDADE/.test(texto)) return 'educacao' as const
  if (/AMZN|AMAZON|RENNER|MAGAZINE|MERCADOLIVRE/.test(texto)) return 'compras' as const
  if (/CLARO|VIVO|TIM|ENEL|SABESP|COMGAS|INTERNET/.test(texto)) return 'contas_fixas' as const
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
    definirRendaMensal,
    garantirUsuario,
    gravarTransacoes,
    registrarImport,
  } = await import('../lib/firestore/repo')
  const { ofxAdapter } = await import('../lib/sources/ofx')
  const { classifyTransactions, resolvedFlowType } = await import(
    '../lib/domain/financial-flow'
  )
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

  // A fatura, e não o extrato de conta. Spec 003 §8 C1: o demo é a superfície
  // pública que mais fala pelo produto, e um app que se anuncia como
  // controlador de fatura abrindo num extrato de conta corrente desmente a
  // própria landing antes de qualquer explicação.
  const fixturePath = resolve('tests', 'fixtures', 'derivadas', 'fatura-demo.ofx')
  const buffer = readFileSync(fixturePath)
  const parsed = await ofxAdapter.parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    undefined
  )

  // O mesmo classificador do import real, com o perfil que o arquivo declara.
  // Sem isto, `PAGAMENTO RECEBIDO` entraria como receita e a demo mostraria
  // uma "renda" de R$ 1.500 que o cartão não tem.
  const classificadas = classifyTransactions(
    parsed.transactions,
    'credit_card_negative_expenses'
  )

  const uid = await garantirDemo()
  await apagarTudoDoUsuario(uid)
  await garantirUsuario(uid, email!)
  const accountId = await criarConta(uid, {
    name: 'Cartão demonstração',
    institution: 'Banco Exemplo',
    kind: 'credit_card',
  })

  // A renda do demo existe para o percentual da C3 aparecer. Sem ela, a tela
  // esconde o número — corretamente — e o visitante nunca vê o recurso.
  await definirRendaMensal(uid, 650_000)

  const meses = [
    { month: mesAnterior(mesAtual()), factor: 0.74 },
    { month: mesAtual(), factor: 0.83 },
  ]

  for (const { month, factor } of meses) {
    const derivadas = classificadas.map((transacao, indice) => ({
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
      financialProfile: 'credit_card_negative_expenses',
      filename: `fatura-demo-${month}.ofx`,
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
      accountKind: 'credit_card',
      importId,
      source: 'ofx',
      descriptionClean: (transacao) => anonymize(transacao.description),
    })

    const categorias = comFingerprint.map((transacao) => ({
      fingerprint: transacao.fingerprint,
      month,
      category: categoriaDe(transacao.description, resolvedFlowType(transacao)),
      categorySource: 'user' as const,
      confidence: null,
      descriptionClean: anonymize(transacao.description),
    }))
    await aplicarCategorias(uid, categorias)

    // A métrica da §9 conferida onde ela é barata de conferir. O demo é o
    // único lugar onde a categorização é escrita à mão, então é o único onde
    // ela pode apodrecer sem nenhum teste reprovar.
    const gastos = categorias.filter(
      (c) => c.category !== 'receita' && c.category !== 'outros'
    )
    const classificaveis = comFingerprint.filter(
      (t) => resolvedFlowType(t) !== 'transfer'
    ).length
    const cobertura = Math.round((gastos.length / classificaveis) * 100)
    if (cobertura < 90) {
      throw new Error(
        `Fatura demo com ${cobertura}% fora de "outros"; a spec 003 §9 pede ao menos 90%.`
      )
    }
  }

  console.log(`Conta demo pronta: ${email}`)
  console.log(`FIREBASE_DEMO_UID=${uid}`)
  console.log('Foram criadas duas faturas de cartão, derivadas e anonimizadas.')
}

main().catch((erro) => {
  console.error(erro)
  process.exitCode = 1
})
