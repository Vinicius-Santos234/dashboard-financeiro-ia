import 'server-only'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import * as p from './paths'

/**
 * Cota diária de chamadas à LLM, por usuário.
 *
 * Existe porque os créditos do Gemini ficam no **projeto** e são
 * compartilhados entre desenvolvimento e produção: sem teto, um laço acidental
 * — ou alguém chamando `/api/insights` com `regenerate: true` repetidamente —
 * consome o que foi pago.
 *
 * Fica em arquivo próprio, e não em `repo.ts`, porque não é dado do usuário: é
 * controle de uso de um recurso pago.
 */

export class CotaExcedidaError extends Error {
  constructor(readonly limite: number) {
    super(
      `Limite de ${limite} chamadas de IA por dia atingido. Tente amanhã.`
    )
    this.name = 'CotaExcedidaError'
  }
}

/**
 * O teto do projeto inteiro. A mensagem não diz o número nem "de outros
 * usuários": quem bateu nele não precisa saber quanto o projeto consome, e
 * dizer isso entregaria uma métrica de uso a qualquer visitante.
 */
export class CotaGlobalExcedidaError extends Error {
  constructor() {
    super(
      'A IA atingiu o limite de uso do dia neste ambiente. Tente amanhã.'
    )
    this.name = 'CotaGlobalExcedidaError'
  }
}

/**
 * Dia no fuso de São Paulo, pelo mesmo motivo de `mesAtual()`: o corte da cota
 * deve virar à meia-noite de quem usa, não em UTC.
 */
function diaLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/**
 * Reserva `quantidade` chamadas, ou levanta `CotaExcedidaError`.
 *
 * Contador no Firestore e não em memória: na Vercel cada requisição pode cair
 * numa instância diferente, e um contador em memória protegeria apenas contra
 * o acidente mais bobo.
 *
 * O documento é por dia, então não precisa de rotina de limpeza — a chave muda
 * sozinha, e os dias velhos somem junto com a conta no `recursiveDelete`.
 */
export async function consumirCotaLlm(
  uid: string,
  quantidade: number,
  limiteDiario: number,
  limiteGlobalDiario: number
): Promise<number> {
  if (quantidade <= 0) return 0

  const dia = diaLocal()
  const refUsuario = adminDb().doc(p.cota(uid, dia))
  // Fora de `users/`, porque não pertence a ninguém: é o consumo do projeto.
  // As regras negam tudo lá fora, e só o Admin SDK escreve aqui.
  const refGlobal = adminDb().doc(p.cotaGlobal(dia))

  return await adminDb().runTransaction(async (tx) => {
    // As duas leituras antes das duas escritas, como o Firestore exige.
    const [snapUsuario, snapGlobal] = await tx.getAll(refUsuario, refGlobal)

    const usado = snapUsuario.exists
      ? ((snapUsuario.data()?.llmCalls as number | undefined) ?? 0)
      : 0
    const usadoGlobal = snapGlobal.exists
      ? ((snapGlobal.data()?.llmCalls as number | undefined) ?? 0)
      : 0

    if (usado + quantidade > limiteDiario) {
      throw new CotaExcedidaError(limiteDiario)
    }

    // O teto global é o que realmente protege os créditos: o por usuário é
    // multiplicável, porque o cadastro é aberto e dá para criar contas novas —
    // ou consumir, apagar e recriar.
    if (usadoGlobal + quantidade > limiteGlobalDiario) {
      throw new CotaGlobalExcedidaError()
    }

    tx.set(
      refUsuario,
      { llmCalls: usado + quantidade, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    )
    tx.set(
      refGlobal,
      {
        llmCalls: usadoGlobal + quantidade,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    return usado + quantidade
  })
}
