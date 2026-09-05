import { describe, it, expect } from 'vitest'
import { ehEmailDemo, ContaDemoError } from '@/lib/domain/demo'
import { sugerirPadrao, encontrarRegra, normalizarPadrao } from '@/lib/domain/rules'
import {
  LIMITE_LLM_DIARIO,
  LIMITE_LLM_GLOBAL_DIARIO,
  MAX_CARACTERES_DESCRICAO,
} from '@/lib/domain/limites'
import { atribuirFingerprints, separarDuplicadas } from '@/lib/domain/fingerprint'
import { inspecionar } from '@/lib/sources/csv'
import { planejarCategorizacao } from '@/lib/llm/categorize'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Regressão dos oito achados da auditoria de 05/09.
 *
 * Cada teste aqui existe porque algo passou despercebido por uma revisão
 * inteira. O nome de cada bloco cita o achado para que, se um deles voltar,
 * quem ler o log saiba exatamente o que quebrou.
 */

describe('achados 1 e 2 — a conta demo é somente-leitura', () => {
  it('reconhece a conta demo pelo e-mail configurado', () => {
    process.env.NEXT_PUBLIC_DEMO_EMAIL = 'demo@exemplo.app'

    expect(ehEmailDemo('demo@exemplo.app')).toBe(true)
    // Caixa e espaço não devem servir de contorno.
    expect(ehEmailDemo('  DEMO@Exemplo.APP  ')).toBe(true)
    expect(ehEmailDemo('outra@pessoa.com')).toBe(false)
    expect(ehEmailDemo(null)).toBe(false)
  })

  it('não trata ninguém como demo quando a variável não existe', () => {
    // Sem isto, um ambiente sem a variável faria `''` casar com `''` e
    // bloquearia contas reais — ou pior, dependendo da comparação.
    delete process.env.NEXT_PUBLIC_DEMO_EMAIL
    expect(ehEmailDemo('')).toBe(false)
    expect(ehEmailDemo(null)).toBe(false)
    expect(ehEmailDemo('alguem@real.com')).toBe(false)
  })

  it('a mensagem do erro diz qual ação foi recusada', () => {
    expect(new ContaDemoError('A exclusão de conta').message).toContain(
      'A exclusão de conta'
    )
  })

  it('toda escrita passa por exigirSessaoGravavel', () => {
    // Guarda de arquitetura: uma rota nova que escreva e chame `exigirSessao`
    // reabriria a demo. Este teste falha quando isso acontecer.
    const raiz = resolve(__dirname, '..')
    const escritores = [
      'app/(app)/conta/actions.ts',
      'app/(app)/transacoes/actions.ts',
      'app/api/categorize/route.ts',
    ]

    for (const arquivo of escritores) {
      const fonte = readFileSync(resolve(raiz, arquivo), 'utf8')
      expect(fonte, `${arquivo} deve usar exigirSessaoGravavel`).toContain(
        'exigirSessaoGravavel'
      )
    }

    // Estes dois leem e escrevem, então checam `demo` explicitamente.
    for (const arquivo of ['app/api/imports/route.ts', 'app/api/insights/route.ts']) {
      const fonte = readFileSync(resolve(raiz, arquivo), 'utf8')
      expect(fonte, `${arquivo} deve tratar a conta demo`).toMatch(/demo/)
    }
  })
})

describe('achado 5 — o padrão sugerido precisa casar de novo', () => {
  it('extrai o estabelecimento e descarta o código do adquirente', () => {
    // Antes devolvia a descrição inteira, que só casava com uma linha idêntica.
    expect(sugerirPadrao('IFD*IFOOD SAO PAULO')).toBe('IFOOD')
    expect(sugerirPadrao('PADARIA SAO JOAO')).toBe('PADARIA')
  })

  it('não sugere regra quando não há nada que identifique', () => {
    // "PIX ENVIADO" viraria uma regra que engole todo PIX da conta.
    expect(sugerirPadrao('PIX ENVIADO')).toBe('')
    expect(sugerirPadrao('TED RECEBIDO')).toBe('')
    expect(sugerirPadrao('PAGAMENTO DE FATURA')).toBe('')
  })

  it('descarta números soltos, que nunca se repetem', () => {
    expect(sugerirPadrao('MERCADO 998877 SP')).toBe('MERCADO')
    // Adjacentes entram os dois, porque assim o padrao continua casando.
    expect(sugerirPadrao('POSTO IPIRANGA SAO PAULO')).toBe('POSTO IPIRANGA')
  })

  it('e o padrão sugerido realmente casa com a próxima transação', () => {
    // O teste que fecha o achado: sugerir a partir de uma linha e casar noutra.
    const padrao = sugerirPadrao('IFD*IFOOD SAO PAULO')
    const regra = encontrarRegra('IFD*IFOOD SAO PAULO 4471', [
      { pattern: padrao, category: 'alimentacao', hits: 0 },
    ])

    expect(regra?.category).toBe('alimentacao')
  })

  it('mas não casa com um estabelecimento diferente', () => {
    const padrao = sugerirPadrao('IFD*IFOOD SAO PAULO')
    expect(
      encontrarRegra('POSTO IPIRANGA SAO PAULO', [
        { pattern: padrao, category: 'alimentacao', hits: 0 },
      ])
    ).toBeNull()
  })

  it('padrão curto demais continua sendo recusado', () => {
    expect(normalizarPadrao('ab').length).toBeLessThan(3)
  })
})

describe('achados 3, 7 e 8 — invariantes que as regras e o código combinam', () => {
  const rules = readFileSync(
    resolve(__dirname, '..', 'firestore.rules'),
    'utf8'
  )

  it('as rules NÃO permitem escrita de cliente em lugar nenhum', () => {
    // Substitui dois testes anteriores, que conferiam se uma regra de update
    // permitia certos campos e se a cota era protegida. A garantia agora é
    // mais forte e mais simples: o cliente não escreve nada, em canto nenhum.
    //
    // O motivo está no arquivo: o servidor mantém o rollup na mesma transação
    // da transação financeira, e o cliente não sabe disso — toda escrita
    // direta quebraria a invariante em silêncio. Era também o caminho que
    // contornava a conta demo somente-leitura.
    // Tira os comentários primeiro: este arquivo CITA a regra antiga para
    // explicar por que ela saiu, e sem isso o teste analisaria a explicação
    // como se fosse a regra. (Foi o que aconteceu na primeira versão dele.)
    const semComentarios = rules.replace(/\/\/[^\n]*/g, '')

    const permissoes = semComentarios.match(/allow\s+[a-z,\s]+:\s*if\s+[^;]+;/g) ?? []
    expect(permissoes.length).toBeGreaterThan(0)

    for (const permissao of permissoes) {
      const permiteEscrita = /allow[^:]*\b(write|create|update|delete)\b/.test(
        permissao
      )
      if (!permiteEscrita) continue

      expect(
        permissao.replace(/\s+/g, ' '),
        'toda permissão de escrita precisa ser `if false`'
      ).toMatch(/if false;/)
    }
  })

  it('a leitura continua restrita ao dono', () => {
    // Leitura permanece permitida: é o que mantém o isolamento entre usuários
    // como propriedade testável pelo SDK cliente (tests/isolamento.test.ts).
    expect(rules).toContain('allow read: if dono(uid)')
    expect(rules).toContain(
      'return request.auth != null && request.auth.uid == uid'
    )
  })

  it('achado 8: o limite diário é um número sensato', () => {
    // Um import de 1000 transações são 20 lotes; um insight é 1.
    expect(LIMITE_LLM_DIARIO).toBeGreaterThanOrEqual(21)
    expect(LIMITE_LLM_DIARIO).toBeLessThanOrEqual(200)
  })

  it('achado 6: as rotas de IA não logam o objeto de erro cru', () => {
    const raiz = resolve(__dirname, '..')
    for (const arquivo of ['app/api/categorize/route.ts', 'app/api/insights/route.ts']) {
      const fonte = readFileSync(resolve(raiz, arquivo), 'utf8')
      // `console.error('...', erro)` mandava a resposta crua do provedor —
      // que pode carregar trechos do payload — para os logs.
      expect(fonte, arquivo).not.toMatch(/console\.error\([^)]*,\s*erro\s*\)/)
      expect(fonte, arquivo).toContain('erro instanceof Error ? erro.message')
    }
  })
})

describe('revisão final do Codex — regressão', () => {
  it('FITID repetido não emite alternativo, para não comer linha legítima', () => {
    // O bug que eu introduzi ao corrigir o achado 3.3 da rodada anterior:
    // quando o banco repete o FITID, todas as linhas compartilhavam o mesmo
    // alternativo `ofx_…`. Se uma já estivesse gravada, as outras eram
    // acusadas de duplicata e sumiam.
    const [a, b] = atribuirFingerprints('conta', [
      { occurredOn: '2026-08-14', amountCents: -1000, description: 'COMPRA A', fitid: 'X' },
      { occurredOn: '2026-08-14', amountCents: -2000, description: 'COMPRA B', fitid: 'X' },
    ])

    expect(a.alternativos).toEqual([])
    expect(b.alternativos).toEqual([])
  })

  it('e por isso a segunda linha sobrevive quando a primeira já existe', () => {
    const arquivo1 = atribuirFingerprints('conta', [
      { occurredOn: '2026-08-14', amountCents: -1000, description: 'COMPRA A', fitid: 'X' },
    ])
    const gravados = arquivo1.map((t) => t.fingerprint)

    // Arquivo 2: a mesma COMPRA A e uma COMPRA B nova, ambas com o FITID
    // defeituoso repetido.
    const arquivo2 = atribuirFingerprints('conta', [
      { occurredOn: '2026-08-14', amountCents: -1000, description: 'COMPRA A', fitid: 'X' },
      { occurredOn: '2026-08-14', amountCents: -2000, description: 'COMPRA B', fitid: 'X' },
    ])

    const { novas } = separarDuplicadas(arquivo2, gravados)

    // COMPRA B tem que entrar. Antes da correção, sumia.
    expect(novas.map((t) => t.description)).toContain('COMPRA B')
  })

  it('a sugestão de mapeamento não chuta formato de data', () => {
    // A recusa de ambiguidade existia e a UI a contornava: `inspecionar`
    // devolvia o palpite, a tela copiava para o mapeamento, e o `parse` via um
    // formato informado e não questionava.
    const ambiguo = 'Data;Historico;Valor\n04/05/2026;A;-10,00\n06/07/2026;B;-20,00\n'
    const r = inspecionar(ambiguo)

    expect(r.formatoDataCerto).toBe(false)
    expect(r.sugestao.formatoData).toBeUndefined()
  })

  it('mas sugere quando tem certeza', () => {
    const claro = 'Data;Historico;Valor\n25/08/2026;A;-10,00\n06/07/2026;B;-20,00\n'
    const r = inspecionar(claro)

    expect(r.formatoDataCerto).toBe(true)
    expect(r.sugestao.formatoData).toBe('dd/mm/yyyy')
  })

  it('o plano de categorização não cobra pelo que as regras resolvem', () => {
    // A cota conta chamadas reais. Antes a rota estimava os lotes sobre toda
    // saída sem opt-out, e as regras só entravam depois: 1.000 transações que
    // casassem com regras gastavam 20 unidades e faziam zero chamadas.
    const transacoes = Array.from({ length: 100 }, (_, i) => ({
      fingerprint: `h_${i}`,
      occurredOn: '2026-08-14',
      month: '2026-08',
      amountCents: -1000,
      descriptionClean: 'UBER TRIP',
      aiOptOut: false,
    }))

    const plano = planejarCategorizacao(transacoes, [
      { pattern: 'UBER', category: 'transporte', hits: 0 },
    ])

    expect(plano.lotes).toBe(0)
    expect(plano.paraIa).toHaveLength(0)
    expect(plano.prontas).toHaveLength(100)
  })

  it('há teto global além do teto por usuário', () => {
    // O teto por usuário é multiplicável: o cadastro é aberto, então quem
    // quiser gastar os créditos cria contas.
    expect(LIMITE_LLM_GLOBAL_DIARIO).toBeGreaterThan(LIMITE_LLM_DIARIO)
  })

  it('a descrição enviada à LLM tem corte de tamanho', () => {
    // A cota conta chamadas, não tokens: um lote de descrições gigantes custa
    // o mesmo e gasta ordens de grandeza mais.
    expect(MAX_CARACTERES_DESCRICAO).toBeGreaterThan(40)
    expect(MAX_CARACTERES_DESCRICAO).toBeLessThan(400)
  })

  it('o login desloga do SDK cliente e usa persistência em memória', () => {
    // Guarda de arquitetura para o crítico 1: enquanto existir
    // `auth.currentUser`, o visitante da demo chama `deleteUser()` pelo console
    // e apaga a demonstração — sem passar por nenhuma rota nossa.
    const fonte = readFileSync(
      resolve(__dirname, '..', 'app/(auth)/login/page.tsx'),
      'utf8'
    )
    expect(fonte).toContain('inMemoryPersistence')
    expect(fonte).toContain('signOut(auth)')
  })
})
