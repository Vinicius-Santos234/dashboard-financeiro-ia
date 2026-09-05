import { describe, it, expect } from 'vitest'
import { ehEmailDemo, ContaDemoError } from '@/lib/domain/demo'
import { sugerirPadrao, encontrarRegra, normalizarPadrao } from '@/lib/domain/rules'
import { LIMITE_LLM_DIARIO } from '@/lib/domain/limites'
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

  it('achado 3: as rules permitem o campo que o servidor grava', () => {
    // O servidor persiste `descriptionClean` ao reanonimizar. Antes, a regra
    // de update proibia — as rules descreviam um modelo que não era o real.
    expect(rules).toContain('descriptionClean')
    const updateBlock = rules.slice(rules.indexOf('allow update'))
    expect(updateBlock.slice(0, 400)).toContain('descriptionClean')
  })

  it('achado 8: a cota é derivada e o cliente não escreve nela', () => {
    expect(rules).toMatch(/match \/quota\/\{dia\}/)
    const quotaBlock = rules.slice(rules.indexOf('match /quota/'))
    expect(quotaBlock.slice(0, 300)).toContain('allow write: if false')
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
