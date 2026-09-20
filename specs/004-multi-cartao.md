# Spec 004 — Mais de um cartão, e o cartão com nome

**Status:** rascunho, não aprovada
**Data:** 2026-09-19
**Emenda:** `specs/003-cartao.md` (implementada) e `specs/002-open-finance.md` (aprovada, não iniciada)
**Origem:** quatro ideias soltas trazidas em 19/09, analisadas contra o código

---

## 1. Por que esta spec existe

Quatro ideias chegaram separadas:

1. poder ter **mais de um cartão** no app;
2. **identificar o banco** automaticamente e mostrar no resumo;
3. **transitar entre os cartões** no resumo;
4. mostrar o **final do número** do cartão no resumo.

Elas são uma coisa só. Todas são consequência de o app ter sido construído
supondo **um cartão**, e nenhuma delas se resolve sozinha: mostrar o banco não
serve para nada se só existe um cartão para mostrar, e trocar de cartão não
serve para nada se os dois se chamam `Cartão principal`.

A 003 estreitou o produto até ele coincidir com a fatura. Esta spec faz a
mesma coisa uma camada abaixo: **o app para de fingir que fatura é uma só.**

---

## 2. Objetivo

O resumo abre no consolidado de todos os cartões e deixa trocar para um
específico, com cada cartão identificado por banco, apelido e os quatro
últimos dígitos.

**Uma frase de sucesso:** quem tem dois cartões abre o resumo, entende em
segundos qual número é de qual, e troca entre eles sem pensar.

---

## 3. Fora de escopo desta spec

| Fora | Por quê |
|---|---|
| **Descoberta automática de cartões** | Depende de Open Finance (002). Aqui cada cartão entra por um arquivo, como hoje |
| **Limite do cartão** | Arquivo nenhum entrega. É a E9 da 002, e continua lá |
| **Comparar cartões entre si numa tela** | A 003 §3 já recusou. Consolidado e individual bastam; "qual cartão gasta mais" é pergunta de outro produto |
| **Conta corrente ganhando seletor** | O produto é controlador de fatura (003 D1). Conta continua suportada e continua sem seletor |
| **Cartão adicional / dependente como entidade** | Vem na mesma fatura e no mesmo arquivo. Separar exige dado que o arquivo não tem |
| **Trocar o cartão de uma transação** | Transação pertence ao arquivo de onde veio. Mover uma linha entre cartões é reescrever identidade (§4.3 da 001) |

---

## 4. O que já existe, e ninguém vê

Antes de planejar trabalho, o que a leitura do código encontrou pronto:

| Já existe | Onde | O que falta |
|---|---|---|
| **Instituição do OFX** | `detectarConta` lê `<ORG>` e `<FID>`; `contaPadrao` grava em `institution` | Nada mostra na tela, e o valor é cru (`BANCO DE TESTE S.A.`, `341`) |
| **Final do número do OFX** | `<ACCTID>` vem como `5555********4444` e entra no **nome** da conta | Nunca é exibido; e não há campo próprio |
| **Fechamento por conta** | `closingDay` / `dueDay` por conta desde a 003 C8 | Nada — já compõe com N cartões |
| **Tipo estável por conta** | `kind` só escrito na criação desde a 003 C6 | Nada |
| **Contas plurais no modelo** | `users/{uid}/accounts`, e a 002 §5 já prevê `accountIds: string[]` | O resto do app supõe uma |

**Duas ideias das quatro estão metade construídas.** O trabalho real não é
capturar banco e final do número — é **mostrar**, dar um caminho para o CSV, e
fazer o resto do app parar de supor um cartão.

### 4.1 O defeito de segurança que a leitura encontrou

`contaPadrao` monta o nome da conta como `${institution} ${ACCTID}`, **sem
mascarar**. Nas fixtures o `ACCTID` vem mascarado pelo emissor
(`5555********4444`), e é por isso que nunca incomodou.

Nada garante isso. Um OFX que traga o **número completo** no `ACCTID` faz o app
gravar um PAN inteiro no nome de um documento — em texto plano, fora de
qualquer anonimização (o `anonymize` só toca descrição de transação).

Não é hipotético o bastante para ser ignorado, e é barato de fechar: ver G7.

---

## 5. Decisões travadas

| # | Decisão | Escolha | Motivo |
|---|---|---|---|
| G1 | Unidade de leitura | **Rollup por (conta, período)** | Hoje o rollup é por período e mistura cartões. Ver §6 |
| G2 | Visão padrão | **Todos os cartões**, consolidado | Quem tem um cartão não pode ganhar um seletor que não faz nada |
| G3 | Consolidar períodos de fechamentos diferentes | **Sim, pela chave do período** | Ver §6.1. A tela diz o intervalo de cada um |
| G4 | Identidade do cartão | **Apelido editável**, sempre | É a saída de emergência de toda heurística. Sem ela, adivinhar errado é permanente |
| G5 | Banco, quando o arquivo diz | **`<ORG>`; `<FID>` por tabela COMPE como reserva** | Já está capturado. Falta normalizar e mostrar |
| G6 | Banco, quando o arquivo não diz | **O nome do arquivo sugere, nunca decide** | Ver §6.2 — esta lição custou um defeito em 19/09 |
| G7 | Número do cartão | **No máximo os 4 últimos, mascarado na entrada** | §4.1. O app nunca guarda nem exibe mais que isso |
| G8 | Percentual da renda (003 D4) | **Acompanha o que está na tela**, com o rótulo dizendo qual | Consolidado mostra o total; um cartão mostra aquele cartão |
| G9 | Migração do rollup | **Script, com backup e conferência — nunca deploy** | A lição da 003 §13, aplicada antes de doer |

---

## 6. A decisão central: o rollup passa a ser por cartão

Hoje o agregado é `users/{uid}/rollups/{YYYY-MM}` — **um por período, para
todos os cartões juntos**. Isso não foi descuido: até a 003 existia um cartão.

Com dois, ele mente por construção. Um resumo de setembro soma as duas faturas
e não tem como separá-las, e é exatamente a separação que as ideias 1 e 3
pedem.

Três saídas foram consideradas:

| Saída | Por que não / por que sim |
|---|---|
| **Ler as transações do mês e agregar em memória** | Simples, e **desfaz a razão de o rollup existir** (001 §4.5: o Firestore não tem `group by`). Trocaria 1 leitura de documento por ~100 |
| **Um mapa `byAccount` dentro do rollup do período** | O rollup já tem dois mapas de 10 categorias. Multiplicar por N contas cresce o documento sem teto, e o Firestore cobra o documento inteiro a cada leitura |
| **Um rollup por (conta, período)** ✅ | 1 documento por cartão por período. Um cartão = 1 leitura, como hoje. Consolidado = N leituras somadas, com N entre 1 e 3 na vida real |

A terceira é a escolhida, e ela **reusa um padrão que já existe**: é a mesma
decisão da 003 D7, que lê N rollups sob demanda em vez de criar um agregado
anual. Ler N e somar já é o jeito desta base de código.

```
users/{uid}/rollups/{accountId}__{periodo}
```

**O custo honesto:** é uma mudança de chave, e mudança de chave é migração —
a única operação do app capaz de corromper histórico. Por isso G9: script com
backup e conferência, nunca deploy (§8 M4).

**O índice novo:** `recalcularRollup` passa a filtrar por conta e período, e
não existe índice composto `(accountId, month)` no `firestore.indexes.json`.
Sem ele a consulta falha em produção e passa em dev, que é a pior combinação.

### 6.1 Consolidar cartões com fechamentos diferentes

Dois cartões com fechamento em dias diferentes têm períodos que **cobrem
intervalos de datas diferentes**. A fatura de setembro de um fecha dia 5; a do
outro, dia 20.

Somá-los sob a chave `2026-09` é o que a pessoa quer dizer com *"quanto minhas
faturas de setembro somaram"* — é assim que ela paga, duas faturas no mesmo
mês. Mas não é um intervalo de datas único, e fingir que é seria a mesma
desonestidade que a 003 corrigiu no saldo.

**A escolha:** consolidar pela chave, e **a tela dizer o intervalo de cada
cartão** quando eles divergem. Um rodapé de uma linha resolve; esconder
resolve nada.

### 6.2 O banco, e por que o nome do arquivo não decide

O `<ORG>` do OFX resolve o caso fácil. O CSV não traz nada, e o nome do
arquivo é tentador: `Nubank_2026-08-13.csv` praticamente grita a resposta.

**Ele sugere e não decide**, e isso é lição comprada, não princípio abstrato.
Em 19/09 o app deduzia o dia de fechamento do `periodEnd` do arquivo; num CSV
`periodEnd` é a data da última compra, e a dedução configurou fechamento no dia
3 para um cartão que fecha no dia 5 — reparticionando tudo em torno de uma data
inventada, com lançamentos indo parar num mês que ninguém importou.

O padrão que sobrou dessa correção vale aqui inteiro: **heurística preenche
campo vazio, aparece na tela dizendo que foi deduzida, e nunca sobrescreve o
que a pessoa escreveu** (G4).

---

## 7. Modelo de dados

A conta ganha três campos. Nenhuma coleção nova.

```ts
type Conta = {
  // ... o que já existe: name, institution, kind, closingDay, dueDay
  apelido: string | null        // G4; o que a pessoa chamou de seu
  last4: string | null          // G7; exatamente 4 dígitos, ou nada
  instituicaoNome: string | null // G5; normalizado, para exibir
  instituicaoFonte: 'arquivo' | 'pessoa' | null
}
```

**`last4` é `string` e não `number`** porque `0042` é um final de cartão válido
e `42` não é a mesma coisa.

**Nada disso vai à IA.** O payload de categorização é id opaco, descrição
anonimizada, data e valor (001 §6.2) — conta não entra, e esta spec não muda
isso.

O rollup muda de **chave**, não de forma: os campos são os mesmos, inclusive o
`byAccountKind` que a 003 C2 acrescentou. Com um rollup por conta ele fica
trivialmente com uma entrada só — e continua servindo, porque é dele que a
tela tira a origem.

---

## 8. Etapas e critério de aceite

Ordem por custo crescente e por dependência real. M1 a M3 entregam valor sem
tocar em agregado nenhum; a M4 é a que pode corromper histórico, e vem antes da
M5 porque a M5 não existe sem ela.

### M1 — Dois cartões deixam de ser o mesmo cartão
- [ ] CSV sem identificação de conta para de cair sempre em `Cartão principal`
- [ ] Quando o arquivo não identifica o cartão, a importação **pergunta de qual
      cartão é** — escolher um existente ou criar um novo com apelido
- [ ] `contaPadrao` deixa de derivar identidade só do nome nesse caminho
- **Aceite:** importar duas faturas de cartões diferentes, ambas CSV e ambas
  sem id de conta, e existirem **duas** contas — com os lançamentos de cada uma
  sob a sua. Hoje existe uma só, e a segunda importação engorda a primeira.
- **Cuidado:** o `accountId` entra no fingerprint (001 §4.3). Mudar como ele é
  derivado para contas **já existentes** duplicaria o histórico inteiro na
  próxima importação — o id derivado é entrada do fingerprint. O caminho novo
  vale para cartão novo; o que existe fica onde está.

### M2 — O cartão ganha nome, banco e final
- [ ] `apelido`, `last4` e `instituicaoNome` no modelo e em `/conta`
- [ ] `<ORG>` normalizado; `<FID>` resolvido por tabela COMPE quando `<ORG>` faltar
- [ ] **Máscara na entrada:** qualquer identificador de conta é reduzido aos 4
      últimos dígitos antes de ser gravado, em qualquer caminho de importação
- [ ] O nome do arquivo pode sugerir o banco; a tela diz que foi deduzido
- **Aceite:** importar o OFX de cartão e a tela mostrar o banco e `•••• 4444`
  sem ninguém digitar nada. Passar um arquivo com número **completo** no
  `ACCTID` e o banco guardar **quatro dígitos**, conferido no console do
  Firestore. Renomear o cartão e o nome deduzido não voltar no import seguinte.

### M3 — O resumo mostra de quem é a fatura
- [ ] Cabeçalho do resumo com apelido, banco e final do cartão
- [ ] Com um cartão só, **nada muda** na tela além do cabeçalho
- **Aceite:** conta com um cartão não ganha nenhum controle novo. A 003 §9
  continua valendo: zero números sem sentido na tela.

### M4 — O rollup por cartão
- [ ] Chave passa a ser `{accountId}__{periodo}`
- [ ] Índice composto `(accountId, month)` no `firestore.indexes.json`,
      **publicado antes do deploy**
- [ ] `recalcularRollup` por conta e período
- [ ] Migração com backup antes, recálculo e releitura conferida depois
- **Aceite:** a soma dos rollups por cartão de um período bate campo a campo com
  o rollup consolidado de antes da migração, e a soma geral de todos os
  períodos não muda em um centavo. O script recusa `--apply` sem `--project`,
  como `migrar:faturas`.
- **Depende de:** M1 e M2 concluídas.
- **Por que não é a última:** a 003 pôs a migração no fim porque a C8 dependia
  de três etapas antes dela. Aqui é o contrário — a tela da M5 **não existe**
  sem este agregado, e adiar significaria enviar um seletor que varre o mês a
  cada troca, para depois reescrevê-lo. Migração arriscada se protege com
  backup e conferência, não com posição na lista.

### M5 — Trocar de cartão
- [ ] Seletor no resumo: **Todos os cartões** (padrão) e um por cartão
- [ ] O seletor **não aparece** com menos de dois cartões (G2)
- [ ] A escolha atravessa resumo, lançamentos e tendência
- [ ] Percentual da renda acompanha a seleção, com o rótulo dizendo qual (G8)
- [ ] Com fechamentos diferentes entre cartões, o consolidado diz o intervalo
      de cada um (§6.1)
- **Aceite:** com dois cartões, o consolidado bate **ao centavo** com a soma
  dos dois individuais, em todas as três telas — e desenhar o resumo custa
  **uma leitura por cartão**, conferido, e não uma varredura do período.
- **Depende de:** M4.

---

## 9. Métricas de qualidade

Herdadas da 003 §9, com duas novas:

| Métrica | Alvo |
|---|---|
| Consolidado × soma dos individuais | Ao centavo, nas três telas |
| Números sem sentido na tela | **Zero** (inalterado) |
| **Dígitos de cartão guardados** | **No máximo 4**, em qualquer caminho de entrada |
| **Leituras para desenhar o resumo** | **1 por cartão**, e não uma varredura do período |

---

## 10. Riscos

| Risco | Mitigação |
|---|---|
| Mudar derivação de `accountId` duplicar histórico | M1 vale para cartão novo; o existente não se move. O fingerprint depende dela |
| M4 corromper histórico | Script com backup e releitura conferida, índice publicado antes (G9). A proteção é o procedimento, não a posição na lista |
| Índice faltando em produção | A consulta filtrada passa em dev e falha em produção. O aceite da M4 exige o índice publicado **antes** |
| Heurística de banco errar e grudar | Apelido editável (G4), e dedução nunca sobrescreve o que a pessoa escreveu |
| PAN completo gravado por um emissor exótico | Máscara na entrada, em todo caminho (G7 / M2) |
| Seletor aparecer para quem tem um cartão | G2: com menos de dois, ele não existe |
| Consolidado somar intervalos diferentes | Decidido em G3 e **dito na tela** (§6.1), em vez de escondido |

---

## 11. Pendências

- [ ] **Medir `<ORG>` e `<FID>` em OFX brasileiro de verdade.** A tabela COMPE
      da G5 só vale se os emissores de fato preencherem. Hoje há uma fixture e
      um arquivo real — amostra pequena demais para uma tabela.
- [ ] **Decidir se `last4` entra no fingerprint.** Não deve, porque mudaria
      identidade de transação já gravada — mas convém escrever isso antes que
      alguém ache que é um bom desempate.
- [ ] **Definir o que o seletor faz na tela de Regras.** Regra é por padrão de
      descrição e não por cartão; provavelmente fica fora do seletor, e isso
      precisa ser dito em vez de acontecer.
- [ ] Confirmar se vale um estado *"cartão arquivado"* — cartão cancelado que
      não deve aparecer no seletor, mas cujo histórico não se apaga.

---

## 12. O que o Open Finance muda aqui

Nada desta spec depende da 002, e é de propósito: cada cartão entra por um
arquivo, como hoje. O que a 002 faz é **melhorar as mesmas coisas**, sem
mudar o modelo:

| Aqui, por arquivo | Com Open Finance (002) |
|---|---|
| Um arquivo por cartão, importado à mão | Cartões **descobertos** na conexão — a E8 já busca contas de cartão |
| Banco por `<ORG>`, tabela COMPE ou palpite do nome do arquivo | Instituição **autoritativa**, sem heurística |
| `last4` do `<ACCTID>` quando o OFX traz | Vem da fonte, para todo cartão |
| Fechamento digitado (003 C8) | A fonte entrega faturas com data de fechamento |
| Sem limite | **Limite do cartão** — a E9, a única informação que justifica a fonte sozinha |

**A 002 §5 já previa isto:** `accountIds: string[]` numa conexão sempre supôs
mais de uma conta. Esta spec é o que torna esse plural visível no produto — e
constrói o modelo que a 002 vai popular, em vez de a 002 ter que inventá-lo.

---

## 13. Referências

- `specs/003-cartao.md` — a fatura como unidade, o fechamento por conta, e a lição da §13 sobre migração
- `specs/002-open-finance.md` — a fonte que torna G5 e a descoberta automáticas
- `specs/001-v1.md` — §4.1 a árvore, §4.3 o fingerprint, §4.5 o rollup, §6.2 o payload da IA
- Sessão de 19/09: a spec 003 implementada, e os defeitos de heurística que ensinaram a G6
