import 'server-only'
import { createHash } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import type { Categoria } from '@/lib/domain/categories'
import {
  contagemPorTipoVazia,
  origemDasContas,
  type Origem,
  type TipoConta,
} from '@/lib/domain/account'
import {
  categoriaAposFluxo,
  resolvedFlowType,
  type FlowType,
  type StatementProfile,
} from '@/lib/domain/financial-flow'
import {
  diaDeFechamentoValido,
  periodoDaFatura,
} from '@/lib/domain/invoice'
import { normalizarPadrao, type RegraCategoria } from '@/lib/domain/rules'
import type { InsightBody } from '@/lib/llm/schema'
import type { TransacaoCategorizavel } from '@/lib/llm/categorize'
import {
  normalizeDescription,
  fingerprintPorConteudo,
  separarDuplicadas,
  type ComFingerprint,
} from '@/lib/domain/fingerprint'
import * as p from './paths'
import {
  aplicarDelta,
  calcularRollup,
  deltaDeInsercao,
  deltaDeRecategorizacao,
  deltaDeMudancaDeFluxo,
  deltaSoDeCategoria,
  origemDoRollup,
  porCategoriaVazio,
  rollupVazio,
  type LinhaAgregavel,
  type Rollup,
} from './rollup'

/**
 * Todo acesso do servidor ao Firestore passa por aqui. Spec §3.1.
 *
 * A regra que não se quebra: **`uid` é o primeiro argumento de tudo**, e o
 * caminho é montado a partir dele. O Admin SDK ignora as Security Rules, então
 * não existe rede de proteção embaixo — a proteção é não haver como escrever
 * uma query sem dizer de quem são os dados.
 */

export interface TransactionDoc {
  accountId: string
  /**
   * O tipo da conta de origem, copiado no momento da gravação. Spec 003 §8 C2.
   *
   * Denormalizado de propósito: `recalcularRollup` precisa da origem de cada
   * linha, e fazer o join com `accounts` a cada recálculo seria uma leitura
   * por conta dentro da transação que já é a mais cara do app. É seguro
   * porque, desde a C6, o `kind` é escrito uma única vez, na criação da conta,
   * e nunca mais muda.
   *
   * Ausente em documentos gravados antes desta versão; quem lê resolve pelo
   * `accountId`.
   */
  accountKind?: TipoConta
  importId: string | null
  occurredOn: string
  month: string
  amountCents: number
  /** Ausente apenas em documentos legados; nesse caso o sinal antigo vale. */
  flowType?: FlowType
  descriptionRaw: string
  descriptionClean: string
  fitid: string | null
  category: Categoria | null
  categorySource: 'ai' | 'rule' | 'user' | null
  confidence: number | null
  source: 'ofx' | 'csv' | 'bot' | 'openfinance'
  aiOptOut: boolean
  /** Incrementada em cada escolha manual, inclusive ao permitir IA novamente. */
  categoryRevision?: number
}

export async function garantirUsuario(uid: string, email: string | null) {
  await adminDb().doc(p.usuario(uid)).set(
    { email, criadoEm: FieldValue.serverTimestamp() },
    { merge: true }
  )
}

/**
 * O perfil da pessoa. Spec 003 §7.
 *
 * `rendaAtualizadaEm` sai como **string ISO**, e não como `Timestamp`: a
 * classe do Firestore não atravessa a fronteira Server → Client Component, e
 * espalhar o documento cru é o erro que `paraTransacao` documenta logo abaixo.
 */
export interface PerfilUsuario {
  email: string | null
  /** `null` = a pessoa não informou. Não é o mesmo que zero (003 §7). */
  rendaMensalCents: number | null
  rendaAtualizadaEm: string | null
  /**
   * Fechamento e vencimento declarados **antes de existir cartão nenhum**.
   *
   * O dia de fechamento é propriedade do cartão, e o lugar natural dele é a
   * conta — mas a conta só nasce na primeira importação, e é exatamente essa
   * importação que precisa dele. Sem isto, a ordem obrigatória era: importar
   * torto, descobrir, configurar, migrar.
   *
   * Aqui é o que a pessoa sabe sobre o cartão dela antes de o app conhecer o
   * cartão. Quando a conta nasce, ela herda estes valores; depois disso quem
   * manda é a conta, e este campo deixa de ser consultado.
   */
  fechamentoPadraoCartao: number | null
  vencimentoPadraoCartao: number | null
}

export async function lerPerfil(uid: string): Promise<PerfilUsuario> {
  const snap = await adminDb().doc(p.usuario(uid)).get()
  const dados = snap.data() as
    | {
        email?: string | null
        rendaMensalCents?: number | null
        rendaAtualizadaEm?: { toDate(): Date } | null
        fechamentoPadraoCartao?: number | null
        vencimentoPadraoCartao?: number | null
      }
    | undefined

  return {
    email: dados?.email ?? null,
    rendaMensalCents:
      typeof dados?.rendaMensalCents === 'number' ? dados.rendaMensalCents : null,
    rendaAtualizadaEm: dados?.rendaAtualizadaEm?.toDate().toISOString() ?? null,
    fechamentoPadraoCartao: diaDeFechamentoValido(dados?.fechamentoPadraoCartao)
      ? dados.fechamentoPadraoCartao
      : null,
    vencimentoPadraoCartao:
      typeof dados?.vencimentoPadraoCartao === 'number'
        ? dados.vencimentoPadraoCartao
        : null,
  }
}

/**
 * Guarda o fechamento que a pessoa declarou antes de ter cartão cadastrado.
 *
 * Não toca em conta nenhuma: quem já tem fechamento próprio continua com o
 * dele. Isto só existe para a **primeira** importação nascer certa.
 */
export async function definirFechamentoPadrao(
  uid: string,
  closingDay: number | null,
  dueDay: number | null
): Promise<void> {
  await adminDb()
    .doc(p.usuario(uid))
    .set(
      { fechamentoPadraoCartao: closingDay, vencimentoPadraoCartao: dueDay },
      { merge: true }
    )
}

/**
 * Grava a renda mensal, ou a apaga quando vem `null`.
 *
 * Apagar precisa escrever `null` de verdade, e não omitir o campo: com
 * `merge`, omitir deixaria o valor anterior no documento, e o critério de
 * aceite da C3 pede que a renda apagada volte ao primeiro estado **sem deixar
 * resíduo**.
 */
export async function definirRendaMensal(
  uid: string,
  rendaMensalCents: number | null
): Promise<void> {
  await adminDb()
    .doc(p.usuario(uid))
    .set(
      {
        rendaMensalCents,
        rendaAtualizadaEm:
          rendaMensalCents === null ? null : FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
}

export type { TipoConta }

export async function criarConta(
  uid: string,
  dados: { name: string; institution?: string | null; kind: TipoConta }
): Promise<string> {
  const ref = adminDb().collection(p.contas(uid)).doc()
  await ref.set({
    name: dados.name,
    institution: dados.institution ?? null,
    kind: dados.kind,
    createdAt: FieldValue.serverTimestamp(),
  })
  return ref.id
}

export interface ContaLida {
  id: string
  name: string
  institution: string | null
  kind: TipoConta
  /**
   * Dia do fechamento da fatura. Spec 003 §8 C8.
   *
   * `null` = não configurado, e então o período continua sendo o mês civil.
   * Esta etapa é **opt-in por conta** de propósito: mudar a chave do rollup é
   * a única operação do app que pode corromper histórico, e não faz sentido
   * fazê-la em conta nenhuma sem alguém pedir.
   */
  closingDay: number | null
  /** Dia do vencimento, só para a tela dizer. Não entra em cálculo nenhum. */
  dueDay: number | null
  /**
   * De onde veio o fechamento — e `'pessoa'` **também quando ela apagou**.
   *
   * `null` significa exatamente *"ninguém nunca decidiu"*, e é a única
   * situação em que o import pode preencher sozinho. Sem essa distinção,
   * apagar o fechamento era indistinguível de nunca tê-lo configurado, e a
   * importação seguinte o repunha a partir do perfil ou do `DTEND` — desfazendo
   * em silêncio uma escolha explícita.
   */
  closingDayFonte: 'arquivo' | 'pessoa' | null
}

function paraConta(d: FirebaseFirestore.DocumentSnapshot): ContaLida {
  const dados = d.data() as Partial<ContaLida>
  return {
    id: d.id,
    name: dados.name ?? 'Conta',
    institution: dados.institution ?? null,
    // Conta gravada sem tipo é tratada como conta corrente: é o que ela era
    // antes de o campo existir, e supor cartão faria a tela esconder o saldo
    // de quem sempre teve um.
    kind: dados.kind ?? 'checking',
    closingDay: diaDeFechamentoValido(dados.closingDay) ? dados.closingDay : null,
    dueDay: typeof dados.dueDay === 'number' ? dados.dueDay : null,
    closingDayFonte: dados.closingDayFonte ?? null,
  }
}

export async function listarContas(uid: string): Promise<ContaLida[]> {
  const snap = await adminDb().collection(p.contas(uid)).get()
  return snap.docs.map(paraConta)
}

export async function obterConta(
  uid: string,
  accountId: string
): Promise<ContaLida | null> {
  const snap = await adminDb().doc(p.conta(uid, accountId)).get()
  return snap.exists ? paraConta(snap) : null
}

/**
 * Configura a fatura de um cartão. Spec 003 §8 C8.
 *
 * **Não remexe no histórico.** Trocar o fechamento muda o período das compras
 * dos próximos imports; as que já estão gravadas continuam onde estão até
 * alguém rodar `npm run migrar:faturas`, que faz backup antes e confere o
 * recálculo depois. Mudar a chave de dado histórico em silêncio, a partir de
 * um campo de formulário, é exatamente o risco que a spec manda evitar.
 */
export async function configurarFatura(
  uid: string,
  accountId: string,
  dados: {
    closingDay: number | null
    dueDay: number | null
    fonte: 'arquivo' | 'pessoa'
  }
): Promise<void> {
  const ref = adminDb().doc(p.conta(uid, accountId))
  const snap = await ref.get()
  if (!snap.exists) throw new Error('Conta não encontrada.')
  if (paraConta(snap).kind !== 'credit_card') {
    throw new Error('Só conta de cartão tem fatura.')
  }

  await ref.set(
    {
      closingDay: dados.closingDay,
      dueDay: dados.dueDay,
      // A fonte é gravada mesmo quando o dia é apagado: apagar é uma decisão,
      // e `null` aqui passaria a significar "nunca decidiram" — devolvendo a
      // conta para o preenchimento automático no import seguinte.
      closingDayFonte: dados.fonte,
    },
    { merge: true }
  )
}

/**
 * Quais destes fingerprints já existem.
 *
 * O Firestore limita `in` a 30 valores por query, então o lote é quebrado. É
 * mais barato que ler o mês inteiro e comparar em memória quando o import é
 * pequeno, e a alternativa (tentar gravar e ver quem falha) desperdiça escrita,
 * que é o que custa caro no Firestore.
 */
export async function fingerprintsExistentes(
  uid: string,
  fingerprints: readonly string[]
): Promise<Set<string>> {
  const achados = new Set<string>()
  const col = adminDb().collection(p.transacoes(uid))

  for (let i = 0; i < fingerprints.length; i += 30) {
    const pedaco = fingerprints.slice(i, i + 30)
    const refs = pedaco.map((fp) => col.doc(fp))
    const docs = await adminDb().getAll(...refs)
    for (const d of docs) if (d.exists) achados.add(d.id)
  }

  return achados
}

export interface ImportDoc {
  accountId: string
  source: 'ofx' | 'csv'
  financialProfile?: StatementProfile
  filename: string
  fileHash: string
  periodStart: string | null
  periodEnd: string | null
  rowsTotal: number
  rowsImported: number
  rowsDuplicated: number
  rowsDiscarded: number
  status: 'parsed' | 'categorized' | 'failed'
  error: string | null
}

export async function registrarImport(
  uid: string,
  dados: ImportDoc
): Promise<string> {
  const ref = adminDb().collection(p.importacoes(uid)).doc()
  await ref.set({ ...dados, createdAt: FieldValue.serverTimestamp() })
  return ref.id
}

export async function atualizarImport(
  uid: string,
  importId: string,
  dados: Partial<ImportDoc>
): Promise<void> {
  await adminDb().doc(p.importacao(uid, importId)).update(dados)
}

export async function obterImport(uid: string, importId: string): Promise<ImportDoc | null> {
  const snap = await adminDb().doc(p.importacao(uid, importId)).get()
  return snap.exists ? snap.data() as ImportDoc : null
}

/** Releitura imediatamente antes de cada envio: alterações feitas noutra aba
 * durante lotes anteriores retiram a linha do próximo payload. */
export async function revalidarPendentes(
  uid: string, linhas: readonly TransacaoCategorizavel[]
): Promise<Set<string>> {
  if (linhas.length === 0) return new Set()
  const docs = await adminDb().getAll(
    ...linhas.map((t) => adminDb().doc(p.transacao(uid, t.fingerprint)))
  )
  return new Set(docs.flatMap((doc, i) => {
    if (!doc.exists) return []
    const atual = doc.data() as TransactionDoc
    return atual.category === null && !atual.aiOptOut &&
      (atual.categoryRevision ?? 0) === (linhas[i].categoryRevision ?? 0)
      ? [doc.id] : []
  }))
}

/**
 * Importações anteriores do mesmo arquivo, pelo sha256.
 *
 * Não bloqueia nada — reimportar é legítimo e quem impede linha duplicada é o
 * fingerprint. Serve para a tela poder dizer "você já importou este arquivo em
 * tal data", que é informação e não impedimento.
 */
export async function importsComMesmoHash(uid: string, fileHash: string) {
  const snap = await adminDb()
    .collection(p.importacoes(uid))
    .where('fileHash', '==', fileHash)
    .get()

  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ImportDoc) }))
}

export async function listarImports(uid: string) {
  const snap = await adminDb()
    .collection(p.importacoes(uid))
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ImportDoc & { createdAt?: { toDate(): Date } }) }))
}

/**
 * A conta usada quando o extrato não identifica nenhuma.
 *
 * O id é **derivado do nome**, e não sorteado. A versão anterior consultava por
 * nome e criava um documento com id aleatório se não achasse — consulta e
 * criação fora de qualquer transação. Duas importações simultâneas passavam as
 * duas pela consulta vazia e criavam **duas contas diferentes**; como o
 * `accountId` entra no fingerprint (§4.3), os mesmos lançamentos ganhavam
 * identidades distintas e o extrato inteiro entrava duas vezes, com o rollup
 * dobrado junto.
 *
 * Com id determinístico, a segunda chamada simplesmente encontra o documento
 * que a primeira criou — não há janela entre "não existe" e "criei".
 *
 * **A separação por tipo vem do NOME, e não de hashear o `kind`** (003 §8 C6).
 * É a diferença entre uma mudança cirúrgica e uma migração: o `accountId`
 * entra no fingerprint, então misturar o tipo no hash daria id novo para todo
 * cartão já gravado — inclusive os que sempre estiveram certos — e o extrato
 * inteiro entraria duplicado no import seguinte. Quem chama nomeia a conta de
 * cartão de `Cartão principal` e a de conta corrente de `Conta principal`, e
 * isso basta para as duas pararem de dividir documento.
 */
function idPorNome(name: string): string {
  return (
    'acc_' +
    createHash('sha256')
      .update(normalizeDescription(name), 'utf8')
      .digest('hex')
      .slice(0, 24)
  )
}

/**
 * O nome que o CSV de cartão usava antes de a C6 separar fatura de conta.
 *
 * Quem importou fatura em CSV antes daquela mudança tem os lançamentos sob o
 * id derivado deste nome. Ver `contaPadrao`.
 */
const NOME_LEGADO_SEM_ID = 'Conta principal'

export async function contaPadrao(
  uid: string,
  sugestao: { name: string; institution?: string | null; kind: TipoConta }
): Promise<string> {
  let id = idPorNome(sugestao.name)

  /**
   * A herança da conta legada, e por que ela existe. Spec 003 §8 C6.
   *
   * A C6 renomeou a conta padrão do CSV de cartão de `Conta principal` para
   * `Cartão principal`, para fatura e conta pararem de dividir documento. O
   * nome entra no hash do id, o id entra no **fingerprint** (001 §4.3), e o
   * fingerprint é a identidade da transação — então, para quem já tinha
   * importado, reimportar o mesmo arquivo gravaria tudo de novo sob
   * identidades novas. Uma revisão externa reproduziu: `gravadas: 1,
   * jaExistiam: 0` numa compra que já estava lá, dobrando o gasto.
   *
   * A herança fecha isso sem desfazer a C6: se o documento legado existe **e
   * é de cartão**, ele continua sendo o cartão daquela pessoa. Cada caso:
   *
   *   - conta nova → id novo, nada a herdar;
   *   - quem importou fatura CSV antes → herda, e nada duplica;
   *   - quem tem conta corrente em `Conta principal` → o `kind` é `checking`,
   *     não herda, e o cartão nasce separado como a C6 quer.
   */
  if (sugestao.kind === 'credit_card' && sugestao.name !== NOME_LEGADO_SEM_ID) {
    const legadoId = idPorNome(NOME_LEGADO_SEM_ID)
    const legado = await adminDb().doc(p.conta(uid, legadoId)).get()
    if (legado.exists && (legado.data()?.kind as TipoConta) === 'credit_card') {
      id = legadoId
    }
  }

  const ref = adminDb().doc(p.conta(uid, id))

  await adminDb().runTransaction(async (tx) => {
    const atual = await tx.get(ref)

    // O `kind` só é escrito na CRIAÇÃO — esta é a outra metade da C6.
    //
    // Escrevê-lo a cada import era o defeito: bastava importar uma fatura para
    // a conta corrente da pessoa virar `credit_card` no documento, e com ela
    // toda a leitura da tela. Uma conta cujo tipo muda sozinha não serve para
    // decidir se a tela mostra saldo, que é justamente o que a C2 precisa
    // dela.
    //
    // Com a omissão, o tipo passa a ser **estável**: ele é o que era quando a
    // conta nasceu, e nenhum arquivo importado depois o reescreve.
    tx.set(
      ref,
      {
        name: sugestao.name,
        institution: sugestao.institution ?? null,
        ...(atual.exists
          ? {}
          : { kind: sugestao.kind, createdAt: FieldValue.serverTimestamp() }),
      },
      // `merge` para não sobrescrever `createdAt` de uma conta já existente nem
      // apagar campos que uma versão futura venha a acrescentar.
      { merge: true }
    )
  })

  return id
}

export interface ResultadoGravacao {
  gravadas: number
  jaExistiam: number
}

export interface OpcoesGravacao {
  accountId: string
  /** Tipo da conta de origem; vai para o documento e para o rollup (003 C2). */
  accountKind: TipoConta
  /**
   * Dia do fechamento da fatura, quando a conta tem um. Spec 003 §8 C8.
   *
   * Com ele, o período (`month`) deixa de ser o mês civil e passa a ser o mês
   * em que a fatura fecha. Sem ele — `null` ou ausente —, nada muda.
   */
  closingDay?: number | null
  importId: string
  source: TransactionDoc['source']
  /** Descrição anonimizada (§7.1). */
  descriptionClean: (t: ComFingerprint) => string
}

/**
 * Uma transação do Firestore aceita 500 operações. Aqui são, por lote:
 * N leituras + N escritas + 1 leitura e 1 escrita do rollup. 200 cabe com
 * folga e mantém a transação curta, o que reduz retentativa por contenção.
 */
const LOTE = 200

/**
 * Grava o lote **e** atualiza o rollup do mês na MESMA transação. Spec §4.5.
 *
 * A versão anterior gravava as transações num batch e só depois somava o
 * rollup, em outra operação. Uma falha entre as duas deixava as transações
 * gravadas e o agregado sem elas — e, pior, a reimportação encontrava as
 * linhas como duplicadas, de modo que o rollup **nunca** as receberia. A
 * divergência era permanente e silenciosa.
 *
 * O agrupamento por mês existe porque o rollup é por mês: cada transação do
 * Firestore toca um único documento de agregado.
 */
export async function gravarTransacoes(
  uid: string,
  transacoes: readonly ComFingerprint[],
  opcoes: OpcoesGravacao
): Promise<ResultadoGravacao> {
  if (transacoes.length === 0) return { gravadas: 0, jaExistiam: 0 }

  const col = adminDb().collection(p.transacoes(uid))

  // O período: mês civil para conta, mês de fechamento da fatura para cartão
  // configurado (003 C8). Um só lugar decide, e é o mesmo que agrupa os lotes
  // logo abaixo — sem isso, o documento diria um mês e o rollup atualizaria
  // outro.
  const periodo = (occurredOn: string) =>
    periodoDaFatura(occurredOn, opcoes.closingDay ?? null)

  const montar = (t: ComFingerprint): TransactionDoc => ({
    accountId: opcoes.accountId,
    accountKind: opcoes.accountKind,
    importId: opcoes.importId,
    occurredOn: t.occurredOn,
    month: periodo(t.occurredOn),
    amountCents: t.amountCents,
    flowType: resolvedFlowType(t),
    descriptionRaw: t.description,
    descriptionClean: opcoes.descriptionClean(t),
    fitid: t.fitid ?? null,
    category:
      resolvedFlowType(t) === 'income'
        ? 'receita'
        : resolvedFlowType(t) === 'transfer'
          ? 'outros'
          : null,
    categorySource:
      resolvedFlowType(t) === 'income' || resolvedFlowType(t) === 'transfer'
        ? 'rule'
        : null,
    confidence:
      resolvedFlowType(t) === 'income' || resolvedFlowType(t) === 'transfer'
        ? 1
        : null,
    source: opcoes.source,
    aiOptOut: false,
    categoryRevision: 0,
  })

  const porMes = new Map<string, ComFingerprint[]>()
  for (const t of transacoes) {
    const mes = periodo(t.occurredOn)
    const lista = porMes.get(mes) ?? []
    lista.push(t)
    porMes.set(mes, lista)
  }

  let gravadas = 0
  let jaExistiam = 0

  for (const [mes, doMes] of porMes) {
    const rollupRef = adminDb().doc(p.rollup(uid, mes))

    for (let i = 0; i < doMes.length; i += LOTE) {
      const pedaco = doMes.slice(i, i + LOTE)

      const parcial = await adminDb().runTransaction(async (tx) => {
        // Checa o fingerprint E os alternativos: a mesma transação pode estar
        // gravada sob a outra forma de identidade, se um arquivo anterior a
        // classificou de outro jeito (ComFingerprint.alternativos).
        const ids = [
          ...new Set(pedaco.flatMap((t) => [
            t.fingerprint, ...t.alternativos, ...(t.candidatoFitid ? [t.candidatoFitid] : []),
          ])),
        ]

        // No Firestore, TODA leitura vem antes de TODA escrita.
        const [rollupSnap, ...docs] = await tx.getAll(
          rollupRef,
          ...ids.map((id) => col.doc(id))
        )

        const existentes = docs.filter((d) => d.exists).map((d) => d.id)
        const conteudosPorId = new Map(docs.filter((d) => d.exists).map((d) => {
          const dados = d.data() as TransactionDoc & { contentFingerprint?: string }
          return [d.id, dados.contentFingerprint ?? fingerprintPorConteudo(
            dados.accountId, dados.occurredOn, dados.amountCents, dados.descriptionRaw, 0
          )]
        }))

        // Duplicata é decidida por LEITURA, não por capturar exceção. A versão
        // anterior fazia `catch { jaExistiam += 1 }`, que contava timeout e
        // indisponibilidade como "já existia" — linhas nunca gravadas sumiam do
        // relatório com o rótulo errado. Agora erro de infraestrutura sobe e
        // derruba o import, que é o comportamento honesto.
        //
        // A decisão em si é a mesma de `separarDuplicadas`, e é ela que roda —
        // não uma cópia. Reimplementar o casamento aqui faria os testes do
        // critério de aceite da E2 provarem uma função que o app não chama.
        const { novas, duplicadas } = separarDuplicadas(pedaco, existentes, conteudosPorId)

        if (novas.length === 0) {
          return { gravadas: 0, jaExistiam: duplicadas.length }
        }

        const base = rollupSnap.exists
          ? (rollupSnap.data() as Rollup)
          : rollupVazio(mes)

        const documentosNovos = novas.map((t) => ({ t, doc: montar(t) }))
        const novo = aplicarDelta(
          base,
          deltaDeInsercao(
            documentosNovos.map(({ doc }) => doc)
          )
        )

        for (const { t, doc } of documentosNovos) {
          tx.create(col.doc(t.fingerprint), {
            ...doc,
            ...(t.contentFingerprint ? { contentFingerprint: t.contentFingerprint } : {}),
            createdAt: FieldValue.serverTimestamp(),
          })
        }
        tx.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })

        return {
          gravadas: novas.length,
          jaExistiam: duplicadas.length,
        }
      })

      gravadas += parcial.gravadas
      jaExistiam += parcial.jaExistiam
    }
  }

  return { gravadas, jaExistiam }
}

/** Muda a categoria de uma transação e move o valor no rollup, atomicamente. */
export async function recategorizar(
  uid: string,
  fingerprint: string,
  para: Categoria,
  origem: 'ai' | 'rule' | 'user',
  confidence: number | null = null
): Promise<void> {
  const txRef = adminDb().doc(p.transacao(uid, fingerprint))

  await adminDb().runTransaction(async (t) => {
    const snap = await t.get(txRef)
    if (!snap.exists) throw new Error(`Transação ${fingerprint} não existe.`)

    const dados = snap.data() as TransactionDoc
    if (dados.category === para) {
      // Confirmar a mesma categoria também é uma decisão do usuário.
      t.update(txRef, {
        categorySource: origem, confidence,
        categoryRevision: (dados.categoryRevision ?? 0) + 1,
      })
      return
    }

    const rollupRef = adminDb().doc(p.rollup(uid, dados.month))
    const rollupSnap = await t.get(rollupRef)
    const base = rollupSnap.exists
      ? (rollupSnap.data() as Rollup)
      : rollupVazio(dados.month)

    const delta = deltaDeRecategorizacao(
      dados.amountCents,
      dados.category,
      para,
      resolvedFlowType(dados)
    )
    const novo = aplicarDelta(base, deltaSoDeCategoria(delta))

    t.update(txRef, {
      category: para, categorySource: origem, confidence,
      categoryRevision: (dados.categoryRevision ?? 0) + 1,
    })
    t.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })
  })
}

/**
 * Muda o fluxo de uma transação e ajusta o rollup na MESMA transação.
 * Spec 003 §8 C5.
 *
 * Mover uma linha entre `expense`, `refund` e `transfer` mexe em três totais
 * diferentes (§8 C5), e o critério de aceite pede que as três leituras
 * continuem fechando — `bruto − estornos = líquido` — conferidas campo a
 * campo contra `recalcularRollup()`. Por isso o delta não é escrito à mão:
 * `deltaDeMudancaDeFluxo` agrega a linha duas vezes e devolve a diferença.
 */
export async function corrigirFluxo(
  uid: string,
  fingerprint: string,
  para: FlowType
): Promise<void> {
  const txRef = adminDb().doc(p.transacao(uid, fingerprint))

  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(txRef)
    if (!snap.exists) throw new Error('Transação não encontrada.')

    const dados = snap.data() as TransactionDoc
    const de = resolvedFlowType(dados)

    const categoriaDepois = categoriaAposFluxo(
      de,
      para,
      dados.category,
      dados.categorySource
    )
    if (de === para && categoriaDepois === dados.category) return

    const rollupRef = adminDb().doc(p.rollup(uid, dados.month))
    const rollupSnap = await tx.get(rollupRef)
    const base = rollupSnap.exists
      ? (rollupSnap.data() as Rollup)
      : rollupVazio(dados.month)

    const comum = {
      month: dados.month,
      amountCents: dados.amountCents,
      accountKind: dados.accountKind,
    }
    const novo = aplicarDelta(
      base,
      deltaDeMudancaDeFluxo(
        { ...comum, category: dados.category, flowType: de },
        { ...comum, category: categoriaDepois, flowType: para }
      )
    )

    tx.update(txRef, {
      flowType: para,
      category: categoriaDepois,
      // A escolha é da pessoa, e é ela que a próxima categorização respeita.
      categorySource: categoriaDepois === null ? null : 'user',
      confidence: null,
      categoryRevision: (dados.categoryRevision ?? 0) + 1,
    })
    tx.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })
  })
}

export interface AtualizacaoCategoria {
  fingerprint: string
  month: string
  category: Categoria
  categorySource: 'ai' | 'rule' | 'user'
  confidence: number | null
  descriptionClean?: string
  expectedRevision?: number
}

/**
 * Categoriza em lote e mantém o rollup na mesma transação. Fazer uma
 * transação por linha tornaria um extrato grande lento e caro; agrupar por mês
 * também garante que cada transação do Firestore toque um só rollup.
 */
export async function aplicarCategorias(
  uid: string,
  atualizacoes: readonly AtualizacaoCategoria[]
): Promise<string[]> {
  const aplicadas: string[] = []
  const porMes = new Map<string, AtualizacaoCategoria[]>()
  for (const atualizacao of atualizacoes) {
    const lista = porMes.get(atualizacao.month) ?? []
    lista.push(atualizacao)
    porMes.set(atualizacao.month, lista)
  }

  for (const [mes, doMes] of porMes) {
    for (let inicio = 0; inicio < doMes.length; inicio += LOTE) {
      const pedaco = doMes.slice(inicio, inicio + LOTE)
      const rollupRef = adminDb().doc(p.rollup(uid, mes))
      const referencias = pedaco.map((a) => adminDb().doc(p.transacao(uid, a.fingerprint)))

      const gravadas = await adminDb().runTransaction(async (tx) => {
        const [rollupSnap, ...documentos] = await tx.getAll(rollupRef, ...referencias)
        const aceitas: string[] = []
        let novo = rollupSnap.exists
          ? (rollupSnap.data() as Rollup)
          : rollupVazio(mes)

        for (let indice = 0; indice < documentos.length; indice += 1) {
          const documento = documentos[indice]
          if (!documento.exists) continue

          const atualizacao = pedaco[indice]
          const anterior = documento.data() as TransactionDoc
          if (atualizacao.expectedRevision !== undefined && (
            anterior.category !== null || anterior.aiOptOut ||
            (anterior.categoryRevision ?? 0) !== atualizacao.expectedRevision
          )) continue
          if (anterior.month !== mes) continue
          novo = aplicarDelta(
            novo,
            deltaSoDeCategoria(
              deltaDeRecategorizacao(
                anterior.amountCents,
                anterior.category,
                atualizacao.category,
                resolvedFlowType(anterior)
              )
            )
          )

          tx.update(documento.ref, {
            category: atualizacao.category,
            categorySource: atualizacao.categorySource,
            confidence: atualizacao.confidence,
            ...(atualizacao.descriptionClean
              ? { descriptionClean: atualizacao.descriptionClean }
              : {}),
          })
          aceitas.push(atualizacao.fingerprint)
        }

        if (aceitas.length > 0) {
          tx.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })
        }
        return aceitas
      })
      aplicadas.push(...gravadas)
    }
  }
  return aplicadas
}

export async function listarTransacoesDoImport(uid: string, importId: string) {
  const snap = await adminDb()
    .collection(p.transacoes(uid))
    .where('importId', '==', importId)
    .get()

  return snap.docs.map(paraTransacao)
}

export async function obterTransacao(uid: string, fingerprint: string) {
  const snap = await adminDb().doc(p.transacao(uid, fingerprint)).get()
  return snap.exists
    ? paraTransacao(snap)
    : null
}

/**
 * A regra com o id do documento, para a tela poder editá-la e apagá-la (C4).
 *
 * `createdAt` fica de fora: é `Timestamp`, e a lista atravessa para um Client
 * Component.
 */
export interface RegraLida extends RegraCategoria {
  id: string
}

export async function listarRegras(uid: string): Promise<RegraLida[]> {
  const snap = await adminDb().collection(p.regras(uid)).get()
  return snap.docs.map((d) => {
    const dados = d.data() as RegraCategoria
    return {
      id: d.id,
      // `?? ''` porque documento incompleto já pode existir no banco: versões
      // anteriores recriavam uma regra apagada como `{ hits: 1 }`, sem padrão.
      // Deixar `undefined` vazar fazia `pattern.localeCompare` derrubar a tela
      // inteira no desempate por `hits`.
      pattern: dados.pattern ?? '',
      category: dados.category ?? null,
      hits: dados.hits ?? 0,
      ...(dados.flowType ? { flowType: dados.flowType } : {}),
    }
  })
}

/**
 * Apaga uma regra pelo id do documento. Spec 003 §8 C4.
 *
 * **Uma por vez, sem ação em lote** (003 §10): apagar regras em massa por
 * engano desfaria meses de correção manual, e não existe desfazer.
 *
 * Apagar a regra não recategoriza nada do que já está gravado — o que ela
 * decidiu no passado é dado, não palpite. O que ela deixa de fazer é ser
 * reaplicada no próximo import, que é o defeito que a C4 existe para fechar.
 */
export async function apagarRegra(uid: string, regraId: string): Promise<void> {
  await adminDb().doc(p.regra(uid, regraId)).delete()
}

/** Troca a categoria de uma regra existente, preservando `hits` e o padrão. */
export async function atualizarCategoriaDaRegra(
  uid: string,
  regraId: string,
  category: Categoria
): Promise<void> {
  const ref = adminDb().doc(p.regra(uid, regraId))
  await adminDb().runTransaction(async (tx) => {
    const atual = await tx.get(ref)
    if (!atual.exists) throw new Error('Regra não encontrada.')
    tx.update(ref, { category })
  })
}

/**
 * Id do documento de uma regra.
 *
 * `p.idSeguro` sozinho colide: ele mapeia `.`, `/`, `#`, `$`, `[` e `]` todos
 * para `_`, então "MERCADO.X" e "MERCADO/X" cairiam no mesmo documento — e uma
 * regra sobrescreveria a outra em silêncio, mudando a categoria de transações
 * que nada tinham a ver. O sufixo de hash separa os dois casos, e o prefixo
 * legível continua ajudando quem abre o console do Firestore.
 */
function idDaRegra(padraoNormalizado: string): string {
  const legivel = p.idSeguro(padraoNormalizado).slice(0, 60)
  const hash = createHash('sha256')
    .update(padraoNormalizado, 'utf8')
    .digest('hex')
    .slice(0, 10)
  return `${legivel}_${hash}`
}

export async function salvarRegra(
  uid: string,
  pattern: string,
  /** `null` cria uma regra **só de fluxo**, que não categoriza nada. */
  category: Categoria | null,
  flowType?: FlowType
): Promise<string> {
  const normalizado = normalizarPadrao(pattern)
  if (normalizado.length < 3) throw new Error('O padrão precisa ter ao menos 3 caracteres.')

  const ref = adminDb().doc(p.regra(uid, idDaRegra(normalizado)))
  await adminDb().runTransaction(async (tx) => {
    const atual = await tx.get(ref)
    tx.set(
      ref,
      {
        pattern: normalizado,
        category,
        hits: atual.exists ? ((atual.data()?.hits as number | undefined) ?? 0) : 0,
        // Omitir não apaga, com `merge`. Uma correção só de categoria numa
        // regra que já impunha fluxo preserva o fluxo de propósito: as duas
        // decisões foram tomadas pela pessoa, em momentos diferentes.
        ...(flowType ? { flowType } : {}),
        ...(atual.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true }
    )
  })
  return normalizado
}

export async function incrementarHitsRegras(
  uid: string,
  padroes: readonly string[]
): Promise<void> {
  const contagem = new Map<string, number>()
  for (const padrao of padroes) contagem.set(padrao, (contagem.get(padrao) ?? 0) + 1)
  if (contagem.size === 0) return

  /**
   * O contador incrementa **só o que ainda existe**, e não recria o apagado.
   *
   * A versão anterior usava `set(..., { merge: true })` para não derrubar o
   * batch quando o documento sumisse — `update` falha no inexistente e leva o
   * lote inteiro junto, fazendo a rota responder erro com as categorias já
   * gravadas. Mas `set` com merge **cria** o documento, e o que nascia era
   * `{ hits: 1 }`: uma regra sem `pattern` e sem `category`.
   *
   * Esse fantasma quebrava a tela de regras — a ordenação chama
   * `pattern.localeCompare` no desempate por `hits`, e `pattern` era
   * `undefined`. Uma categorização em andamento numa aba, uma exclusão em
   * outra, e a lista parava de abrir.
   *
   * A leitura antes de escrever resolve os dois: quem foi apagado fica
   * apagado, e o batch continua sem `update` em documento ausente.
   */
  const refs = [...contagem.keys()].map((padrao) =>
    adminDb().doc(p.regra(uid, idDaRegra(padrao)))
  )

  try {
    const existentes = await adminDb().getAll(...refs)
    const batch = adminDb().batch()
    let aIncrementar = 0

    for (const [i, [padrao, hits]] of [...contagem.entries()].entries()) {
      if (!existentes[i]?.exists) continue
      batch.update(adminDb().doc(p.regra(uid, idDaRegra(padrao))), {
        hits: FieldValue.increment(hits),
      })
      aIncrementar += 1
    }

    // E mesmo assim, engolindo a falha: contador de uso é telemetria. O
    // trabalho de verdade já foi feito, e derrubar a resposta por causa dele
    // seria mentir sobre o resultado.
    if (aIncrementar > 0) await batch.commit()
  } catch (erro) {
    console.error(
      'Falha ao contabilizar hits de regras:',
      erro instanceof Error ? erro.message : 'erro desconhecido'
    )
  }
}

export async function definirAiOptOut(
  uid: string,
  fingerprint: string,
  optOut: boolean
): Promise<void> {
  const ref = adminDb().doc(p.transacao(uid, fingerprint))
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new Error('Transação não encontrada.')
    const dados = snap.data() as TransactionDoc

    // Entrada nunca foi para a IA: `categorizarTransacoes` resolve valor
    // positivo como `receita` de forma determinística, antes de qualquer lote.
    // Movê-la para `outros` ao marcar opt-out sumia com o salário do gráfico
    // por uma escolha que não muda nada no que ela faz.
    const ehEntrada = resolvedFlowType(dados) === 'income'
    const destino: Categoria | null = optOut
      ? ehEntrada
        ? 'receita'
        : 'outros'
      : // Ao voltar atrás, a categoria volta a ser NULA para que a próxima
        // categorização a pegue: a rota só seleciona `category === null`, e
        // sem isto "permitir IA" religava a flag e a linha nunca mais era
        // categorizada. Entrada permanece em `receita`, que é determinístico.
        ehEntrada
        ? 'receita'
        : null

    const origem: TransactionDoc['categorySource'] | null =
      destino === null ? null : optOut ? 'user' : 'rule'

    // `null` conta como `outros` em `calcularRollup`, então tirar a categoria
    // de uma saída que já estava em `outros` não move nada — mas a conta é
    // feita de qualquer jeito, para não depender dessa coincidência.
    const categoriaEfetivaAntes = dados.category ?? 'outros'
    const categoriaEfetivaDepois = destino ?? 'outros'

    if (categoriaEfetivaAntes === categoriaEfetivaDepois) {
      tx.update(ref, {
        aiOptOut: optOut,
        categoryRevision: (dados.categoryRevision ?? 0) + 1,
        category: destino,
        categorySource: origem,
        confidence: null,
      })
      return
    }

    const rollupRef = adminDb().doc(p.rollup(uid, dados.month))
    const rollupSnap = await tx.get(rollupRef)
    const base = rollupSnap.exists
      ? (rollupSnap.data() as Rollup)
      : rollupVazio(dados.month)
    const novo = aplicarDelta(
      base,
      deltaSoDeCategoria(
        deltaDeRecategorizacao(
          dados.amountCents,
          categoriaEfetivaAntes,
          categoriaEfetivaDepois,
          resolvedFlowType(dados)
        )
      )
    )

    tx.update(ref, {
      aiOptOut: optOut,
      categoryRevision: (dados.categoryRevision ?? 0) + 1,
      category: destino,
      categorySource: origem,
      confidence: null,
    })
    tx.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })
  })
}

export async function lerRollup(uid: string, mes: string): Promise<Rollup> {
  const snap = await adminDb().doc(p.rollup(uid, mes)).get()
  if (!snap.exists) return rollupVazio(mes)
  const data = snap.data() as Rollup
  return {
    ...data,
    totalRefundCents: data.totalRefundCents ?? 0,
    totalTransferCents: data.totalTransferCents ?? 0,
    // Rollup gravado antes do estorno por categoria não tem o mapa. Normalizar
    // na LEITURA — e não em cada tela — é o que impede o `undefined` de vazar
    // para um `Math.abs` e virar `NaN` no meio de um gráfico.
    refundByCategory: data.refundByCategory ?? porCategoriaVazio(),
    // Zerado quando o rollup é anterior à C2. A origem cai para a lista de
    // contas, e é por isso que `origemDoRollup` devolve `null` em vez de
    // chutar `fatura`.
    byAccountKind: data.byAccountKind ?? contagemPorTipoVazia(),
  }
}

export interface InsightDoc {
  body: InsightBody
  model: string
  generatedAt?: { toDate(): Date }
}

export async function lerInsight(uid: string, mes: string): Promise<InsightDoc | null> {
  const snap = await adminDb().doc(p.insight(uid, mes)).get()
  return snap.exists ? (snap.data() as InsightDoc) : null
}

export async function salvarInsight(
  uid: string,
  mes: string,
  body: InsightBody,
  model: string
): Promise<void> {
  await adminDb().doc(p.insight(uid, mes)).set({
    body,
    model,
    generatedAt: FieldValue.serverTimestamp(),
  })
}

/**
 * Recomputa o rollup varrendo as transações do mês. Spec §4.5.
 *
 * É o botão de conserto para quando o incremental divergir — e a existência
 * dele é o que torna o cache aceitável. Um mês são ~100 documentos.
 *
 * Roda **dentro de uma transação** e não como leitura seguida de escrita. Sem
 * isso, a ferramenta de conserto conseguia corromper: o recálculo lia 99
 * transações, uma importação concorrente gravava a centésima e aplicava o
 * delta dela, e então o recálculo gravava o agregado das 99 — apagando a
 * centésima do gráfico. A transação do Firestore trava os documentos lidos
 * pela query, então a escrita concorrente força a retentativa em vez de ser
 * silenciosamente descartada.
 */
export async function recalcularRollup(uid: string, mes: string): Promise<Rollup> {
  const query = adminDb()
    .collection(p.transacoes(uid))
    .where('month', '==', mes)

  const rollupRef = adminDb().doc(p.rollup(uid, mes))

  // Fora da transação de propósito: o `kind` é imutável desde a C6, então esta
  // leitura não tem o que perder para uma escrita concorrente — e trazê-la
  // para dentro somaria as contas ao conjunto travado pela transação, o que
  // faria toda importação simultânea colidir com todo recálculo.
  const tipoPorConta = new Map(
    (await listarContas(uid)).map((c) => [c.id, c.kind] as const)
  )

  return await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(query)

    const linhas: LinhaAgregavel[] = snap.docs.map((d) => {
      const t = d.data() as TransactionDoc
      return {
        month: t.month,
        amountCents: t.amountCents,
        category: t.category,
        flowType: resolvedFlowType(t),
        // Documento legado não guarda o tipo; o `accountId` ainda resolve.
        accountKind: t.accountKind ?? tipoPorConta.get(t.accountId),
      }
    })

    const novo = calcularRollup(mes, linhas)
    tx.set(rollupRef, { ...novo, updatedAt: FieldValue.serverTimestamp() })

    return novo
  })
}

/**
 * O que sai daqui é sempre um objeto simples, e nunca o documento cru.
 *
 * O documento gravado tem `createdAt` como `Timestamp` do Firestore — uma
 * CLASSE, que não atravessa a fronteira Server → Client Component. Espalhar
 * `d.data()` fazia o tipo mentir (dizia `TransactionDoc`, entregava
 * `TransactionDoc` + extras) e quebrava a tela no instante em que alguma linha
 * virasse componente de cliente. Foi exatamente o que aconteceu.
 *
 * Escolher campo a campo é mais verboso e é o que torna o tipo verdadeiro.
 */
export interface TransacaoLida extends TransactionDoc {
  fingerprint: string
}

function paraTransacao(d: FirebaseFirestore.DocumentSnapshot): TransacaoLida {
  const t = d.data() as TransactionDoc
  return {
    fingerprint: d.id,
    accountId: t.accountId,
    accountKind: t.accountKind,
    importId: t.importId,
    occurredOn: t.occurredOn,
    month: t.month,
    amountCents: t.amountCents,
    flowType: resolvedFlowType(t),
    descriptionRaw: t.descriptionRaw,
    descriptionClean: t.descriptionClean,
    fitid: t.fitid,
    category: t.category,
    categorySource: t.categorySource,
    confidence: t.confidence,
    source: t.source,
    aiOptOut: t.aiOptOut,
    categoryRevision: t.categoryRevision ?? 0,
  }
}

export async function listarTransacoesDoMes(uid: string, mes: string) {
  const snap = await adminDb()
    .collection(p.transacoes(uid))
    .where('month', '==', mes)
    .orderBy('occurredOn', 'desc')
    .get()

  return snap.docs.map(paraTransacao)
}

/**
 * Lê N rollups de uma vez. Spec 003 §5 D7 e §8 C7.
 *
 * **Sem documento agregado novo, de propósito.** Um rollup anual seria um
 * segundo agregado para divergir do primeiro, e o custo de manter agregado em
 * dia já foi cobrado uma vez por `recalcularRollup()`. Seis meses são seis
 * leituras de documento num `getAll` — barato o bastante para não valer uma
 * coleção que pode mentir.
 *
 * Mês sem rollup volta como rollup vazio, e não é omitido: a série precisa do
 * buraco para desenhar a queda.
 */
export async function lerRollups(
  uid: string,
  meses: readonly string[]
): Promise<Rollup[]> {
  if (meses.length === 0) return []

  const docs = await adminDb().getAll(
    ...meses.map((mes) => adminDb().doc(p.rollup(uid, mes)))
  )

  return docs.map((snap, i) => {
    if (!snap.exists) return rollupVazio(meses[i])
    const data = snap.data() as Rollup
    return {
      ...data,
      month: meses[i],
      totalRefundCents: data.totalRefundCents ?? 0,
      totalTransferCents: data.totalTransferCents ?? 0,
      refundByCategory: data.refundByCategory ?? porCategoriaVazio(),
      byAccountKind: data.byAccountKind ?? contagemPorTipoVazia(),
    }
  })
}

/**
 * A origem que a tela do mês deve obedecer. Spec 003 §8 C2.
 *
 * Tenta o rollup primeiro, que é uma leitura de documento já feita pela
 * página. Só quando ele não sabe — mês vazio, ou agregado anterior a esta
 * versão — é que a lista de contas é consultada, e aí a conta corrente
 * prevalece sobre a ausência de informação.
 */
export async function origemDoMes(uid: string, rollup: Rollup): Promise<Origem> {
  return origemDoRollup(rollup) ?? origemDasContas(await listarContas(uid))
}

export async function contarTransacoes(uid: string): Promise<number> {
  const snap = await adminDb().collection(p.transacoes(uid)).count().get()
  return snap.data().count
}

/**
 * Apaga a conta e tudo que está embaixo dela. Spec §7.4 (LGPD).
 *
 * `recursiveDelete` existe exatamente para isso e apaga subcoleções — que um
 * `delete` no documento não faria: no Firestore, apagar o pai deixa os filhos
 * órfãos e ainda legíveis por caminho direto. Esse é o erro clássico de
 * "apagamos a conta" que não apaga nada.
 */
export async function apagarTudoDoUsuario(uid: string): Promise<void> {
  await adminDb().recursiveDelete(adminDb().doc(p.usuario(uid)))
}
