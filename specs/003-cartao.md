# Spec 003 — O app vira um controlador de fatura de cartão

**Status:** aprovada, não iniciada
**Data:** 2026-09-07
**Emenda:** `specs/001-v1.md` (concluída) e `specs/002-open-finance.md` (aprovada, não iniciada)
**Origem:** sessão de decisões arquiteturais de 07/09, sem código

---

## 1. Por que esta spec existe

A 001 entregou tudo que prometeu, e o app está no ar. O problema não é defeito: é
que **o modelo de leitura ficou uma etapa atrás do modelo de dados**.

Em 06/09 a `flowType` passou a distinguir compra, receita, estorno e transferência —
os dados ficaram honestos. A tela continuou sendo a mesma pizza de gasto bruto,
respondendo *"em que eu gastei?"* para um extrato onde **87% do movimento não era
gasto** (R$ 2.054 de R$ 2.361, entre pagamento de fatura e aplicação). Nenhum teste
reprova, porque não há erro. A pergunta é que envelheceu.

A saída não é acrescentar tela. É **estreitar o produto até ele coincidir com o dado
que o categoriza bem**.

---

## 2. Objetivo

Um **controlador de fatura de cartão**: a fatura entra bruta, a IA categoriza, e a
pessoa vê no que a fatura foi gasta — com o percentual da renda que ela consumiu.

**Uma frase de sucesso:** um estranho abre o link, entra na conta demo, e em menos de
30 segundos entende no que aquela fatura foi gasta — sem eu explicar nada, e sem ver
nenhum número que não faça sentido para um cartão.

### A razão técnica, que é mais forte que a de escopo

Fonte e **tipo de extrato** são coisas diferentes, e só o segundo muda a natureza do
dado. A pergunta certa não é de onde o dado vem, é **se o sinal e o dado sensível são
o mesmo campo**:

| Extrato | Descrição típica | O sinal é o dado protegido? |
|---|---|---|
| Conta corrente | `Transferência enviada pelo Pix - FULANO - CPF ••• - Agência 193` | **Sim.** A contraparte é pessoa; anonimizar apaga o sinal |
| Fatura de cartão | `IFD*IFOOD SAO PAULO`, `POSTO IPIRANGA 234` | **Não.** O sinal é o estabelecimento, que nunca foi protegido |

A fatura é o único extrato brasileiro em que a §7 da 001 (privacidade) e a §6 da 001
(categorização) **não brigam**. Isso inverte o que parecia óbvio: a fatura não é o
caso mais pobre, é o mais rico — e a conta corrente é a fonte pobre.

> Consequência medida em 06/09: numa conta corrente, **9 chamadas pagas ao Gemini por
> mês** compravam um `outros` já conhecido, porque o anonimizador havia esvaziado a
> descrição antes.

---

## 3. Fora de escopo desta spec

Escrito antes do resto, pela mesma razão da 001.

| Fora | Por quê |
|---|---|
| **Apagar o caminho de conta corrente** | Está escrito, testado, e o conserto de 06/09 é bom. **Demover, não deletar** — ver §4 |
| Investimentos como domínio | Reclassificado (§5, D6) e **não implementado**. Continua fora |
| Orçamento, meta e alerta de estouro | Precisa de modelo de planejamento; a renda digitada (C3) **não** é orçamento |
| Múltiplos cartões comparados entre si | A conta ganha honestidade em C6, não uma tela de comparação |
| Previsão de fatura futura | Depende da data de fechamento, que só chega em C8 |
| Parcelamento como objeto próprio | Uma compra parcelada segue N linhas, como o extrato entrega |

---

## 4. Demover não é deletar

O caminho de conta corrente **continua funcionando e continua importável**. O que muda
é onde o produto se apresenta:

| Superfície | Passa a ser |
|---|---|
| README, landing, tela vazia, seed do demo | **Cartão**, sem exceção |
| Import | Aceita os dois; o perfil de origem já existe (`bank_account` / `credit_card`) |
| Dashboard e transações | **Obedecem à origem** — números de fatura para fatura, números de conta para conta |

O erro a evitar tem nome: um app que se anuncia como controlador de cartão e mostra
"recebido" e "saldo" na tela é **pior que os dois produtos separados**.

---

## 5. Decisões travadas

Nenhuma volta a ser discutida sem motivo novo e escrito.

| # | Decisão | Escolha | Motivo |
|---|---|---|---|
| D1 | Escopo do produto | **Controlador de fatura de cartão** | A fatura é o extrato que sobrevive ao anonimizador (§2) |
| D2 | Unidade de período | **A fatura**, não o mês civil | É a unidade que a pessoa reconhece. Compras de uma fatura atravessam dois meses civis. Última etapa (C8), por ser a mais cara |
| D3 | Saldo e receita | **Somem quando a origem é fatura** | Cartão não tem saldo. Era este o *"saldo sempre negativo"* de 06/09 — sintoma de tela, não de contabilidade |
| D4 | O denominador | **Renda mensal digitada, uma vez** | Devolve *"gastei X% do que recebi"* sem trazer import de conta de volta |
| D5 | `flowType` | **Corrigível pelo usuário, virando regra** | Só a pessoa sabe. Reusa o mecanismo de regra da 001 §3 D6, sem gastar token |
| D6 | `investimentos` | **Categoria separada dos gastos, mais pra frente** | Investir não é gasto: fatia na pizza de gastos seria mentira. Não entra nesta spec |
| D7 | Leitura de vários meses | **Ler N rollups sob demanda**, sem rollup anual | Um segundo agregado é uma segunda coisa para divergir — custo que `recalcularRollup()` já cobrou |
| D8 | O que traz a pessoa de volta | **Indicador de "último import há X dias"** | Barato. Open Finance é conveniência, não conserto (001 §11) |

---

## 6. O que esta spec emenda na 001

| Onde | O que dizia | O que passa a valer |
|---|---|---|
| §1 Objetivo | "extrato exportado do próprio banco (OFX ou CSV)" | Fatura de cartão é o caso principal; conta corrente é caso secundário suportado |
| §2 Fora de escopo | "Investimentos — outro domínio inteiro" | Continua fora **como domínio**; reclassificado como categoria futura (D6) |
| §5 Dashboard | Cinco números iguais para toda origem | Os números **dependem da origem** (D3) |
| §4.5 Rollup | Chave `YYYY-MM` | Continua `YYYY-MM` até C8; depois, a fatura (D2) |
| §9 Métricas | "≥ 80% fora de `outros`" | **Continua valendo, e agora é mais fácil de bater** — a descrição de fatura carrega o estabelecimento |

**O que a 001 acertou e esta spec confirma:** dinheiro em centavos, fingerprint como id
do documento, o cliente sem escrita, o anonimizador rodando duas vezes, e a `flowType`.
Nada disso muda.

---

## 7. Modelo de dados

Só uma coisa nova. O resto é a árvore da 001 §4.1, intacta.

```
users/{uid}                      ← ganha um campo
```

```ts
type PerfilUsuario = {
  // ... o que já existe
  rendaMensalCents: number | null   // D4; null = a pessoa não informou
  rendaAtualizadaEm: Timestamp | null
}
```

**`null` não é zero, e a diferença aparece na tela.** Sem renda informada, o app **não
mostra percentual nenhum** — não mostra "0%" nem "100%". Um denominador ausente e um
denominador zerado levam a leituras opostas, e inventar o segundo seria mentir.

**A renda mora no perfil, não no rollup.** Ela não é um fato do mês importado; é uma
declaração da pessoa, que vale até ela mudar. Guardá-la por mês criaria a obrigação de
preenchê-la doze vezes para ver uma tendência.

**As Security Rules continuam negando escrita de cliente** (001 §4.4). A renda entra por
Server Action, como todo o resto.

---

## 8. Etapas e critério de aceite

Ordem escolhida por custo crescente e por dependência real. C1 é a decisão virando
texto; C8 é a única que mexe na chave do rollup.

### C1 — A proposta, escrita
- [ ] README, landing, tela vazia e `scripts/seed-demo.ts` falando de **fatura de cartão**
- [ ] O aviso da §7.2 da 001 (risco residual do nome de estabelecimento) reescrito para
      o contexto novo, onde o estabelecimento é **o dado central** e não um efeito colateral
- **Aceite:** ninguém que abre o link precisa perguntar de que o app trata. Nenhuma
  superfície pública ainda diz "extrato bancário" como caso principal.

### C2 — Cartão não tem saldo
- [ ] A origem (`credit_card` / `bank_account`) chega ao dashboard e à lista
- [ ] Origem fatura: **sem saldo e sem recebido**; total da fatura, estornos, líquido e a pizza
- [ ] Origem conta: os cinco números de hoje, inalterados
- **Aceite:** importar a fatura real de 06/09 e **não existir na tela nenhum número
  negativo apresentado como saldo**. Importar o extrato de conta do mesmo dia e a tela
  continuar idêntica à de hoje.

### C3 — Renda mensal digitada (D4)
- [ ] Campo em `/conta`, gravado por Server Action, em **centavos** (001 §3)
- [ ] Dashboard mostra *"a fatura consumiu X% da sua renda"* quando houver valor
- [ ] Sem valor: **nenhum percentual na tela**, e nada quebrado
- **Aceite:** três estados verificados — sem renda (nada aparece), com renda (percentual
  bate ao centavo com `gastoLiquido / rendaMensalCents`), e renda apagada (volta ao
  primeiro estado sem deixar resíduo).

### C4 — Tela de regras
- [ ] `/regras` lista as regras com padrão, categoria e `hits`
- [ ] Editar categoria e **apagar** regra
- [ ] Regra apagada não é reaplicada no import seguinte
- **Aceite:** criar uma regra errada corrigindo uma transação, apagá-la, reimportar o
  mesmo arquivo e a transação **não** voltar categorizada errado. Hoje isso é impossível,
  e é o defeito que esta etapa existe para fechar: **o app aprende e a pessoa não vê o
  que ele aprendeu.**

### C5 — `flowType` corrigível na linha (D5)
- [ ] O painel que já abre na linha ganha a correção de fluxo
- [ ] A correção **vira regra**, como a de categoria
- [ ] O rollup é ajustado na **mesma transação** (001 §4.5) — mover linha entre `expense`,
      `refund` e `transfer` mexe em três totais diferentes
- **Aceite:** reclassificar uma linha e as três leituras continuarem fechando
  (`bruto − estornos = líquido`), conferido campo a campo contra `recalcularRollup()`.

### C6 — `contaPadrao` honesto
- [ ] `kind` **não** é mais sobrescrito a cada import pelo `merge`
- [ ] CSV sem id de conta não joga fatura e conta corrente no mesmo `accountId`
- **Aceite:** importar uma fatura e um extrato de conta, ambos CSV e ambos sem id de
  conta, e existirem **duas** contas com `kind` correto e estável. Hoje existe uma só,
  cujo tipo é o do último import.

### C7 — Tendência de N meses (D7)
- [ ] Leitura de N rollups sob demanda, **sem** documento agregado novo
- [ ] A tela mostra a série por categoria
- **Aceite:** a série de 6 meses bate campo a campo com a soma dos seis rollups lidos
  individualmente, e **nenhuma coleção nova foi criada**.

### C8 — A fatura como unidade de período (D2)
- [ ] Data de fechamento e vencimento no modelo de conta de cartão
- [ ] A chave do rollup deixa de ser o mês civil para origem fatura
- [ ] Migração dos dados existentes, com backup antes e recálculo conferido depois
- **Aceite:** uma compra de 28/09 numa fatura que fecha em 03/10 aparece **na fatura de
  outubro**, e a soma das faturas de um ano bate com a soma das transações do ano.
- **Depende de:** C2, C6 e C7 concluídas. É a etapa que pode corromper dado histórico,
  e é a última de propósito.

---

## 9. Métricas de qualidade

Herdadas da 001 §9, com uma nova e uma mais exigente:

| Métrica | Alvo |
|---|---|
| Transações fora de `outros` | **≥ 90%** numa fatura (a 001 pedia 80% em extrato genérico) |
| Chamadas de IA no 2º mês | ≤ 60% das do 1º, pelas regras (inalterado) |
| Soma das fatias × total da fatura | Ao centavo (inalterado) |
| **Números sem sentido na tela** | **Zero.** Nenhum saldo, receita ou percentual exibido para uma origem que não os tem |

---

## 10. Riscos

| Risco | Mitigação |
|---|---|
| O pivô virar "apagar código que funciona" | §4 é explícita: demover, não deletar. Nenhuma etapa remove o caminho de conta |
| C8 corromper dado histórico | Última etapa, com backup e recálculo conferido; depende de três etapas antes |
| A renda digitada envelhecer em silêncio | `rendaAtualizadaEm` guardado; a tela diz desde quando o valor vale |
| Regras apagadas em massa por engano (C4) | Apagar uma por vez, sem ação em lote |
| Fatura sem estabelecimento legível (`PAGAMENTO RECEBIDO`, ajustes) | Já coberto: descrição esvaziada pelo anonimizador **não vai à IA** desde 06/09 |
| O produto ficar pequeno demais para o portfólio | O oposto do risco real: *"controlador de fatura"* é uma frase verificável; *"dashboard financeiro"* não era |

---

## 11. Pendências

- [ ] Decidir se a renda digitada é **líquida ou bruta**, e dizer isso no campo — a
      pessoa não deve ter que adivinhar qual das duas o percentual usa
- [ ] Definir o texto do aviso de C1 sobre o risco residual, agora que o nome do
      estabelecimento é o dado central e não um efeito colateral
- [ ] Confirmar se alguma fatura brasileira exportada traz data de fechamento no
      arquivo, ou se ela terá de ser informada pela pessoa em C8

---

## 12. Referências

- `specs/001-v1.md` — o que foi construído, e continua valendo
- `specs/002-open-finance.md` — a segunda fonte, agora mirando cartão
- Sessão de decisões de 07/09 (vault: `Projetos/dashboard-financeiro.md`)
