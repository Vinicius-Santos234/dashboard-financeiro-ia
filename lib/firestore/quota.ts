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
  limiteDiario: number
): Promise<number> {
  if (quantidade <= 0) return 0

  const ref = adminDb().doc(p.cota(uid, diaLocal()))

  return await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const usado = snap.exists
      ? ((snap.data()?.llmCalls as number | undefined) ?? 0)
      : 0

    if (usado + quantidade > limiteDiario) throw new CotaExcedidaError(limiteDiario)

    tx.set(
      ref,
      { llmCalls: usado + quantidade, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    )

    return usado + quantidade
  })
}
