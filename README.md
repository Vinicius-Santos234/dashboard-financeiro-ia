# Dashboard Financeiro

**Um controlador de fatura de cartão.** A fatura entra bruta, a IA categoriza, e você vê no que ela foi gasta — com o percentual da renda que ela consumiu. Tudo sem entregar dados bancários crus a terceiros.

Produção: https://dashboard-financeiro-ia.vercel.app

## Por que cartão, e não extrato bancário

O projeto começou como um visualizador genérico de extrato. A spec 003 o estreitou, e a razão é técnica antes de ser de escopo: **fatura de cartão é o único extrato brasileiro em que privacidade e categorização não brigam.**

| Extrato | Descrição típica | O sinal é o dado protegido? |
|---|---|---|
| Conta corrente | `Transferência enviada pelo Pix - FULANO - CPF ••• - Agência 193` | **Sim.** A contraparte é pessoa; anonimizar apaga o sinal |
| Fatura de cartão | `IFD*IFOOD SAO PAULO`, `POSTO IPIRANGA 234` | **Não.** O sinal é o estabelecimento, que nunca foi protegido |

Numa conta corrente medida aqui, o anonimizador esvaziava a descrição antes da chamada e **9 chamadas pagas ao Gemini por mês** compravam um `outros` já conhecido. Na fatura, a descrição carrega o estabelecimento — que é exatamente o que categoriza.

**Conta corrente continua suportada.** A spec 003 §4 é explícita: demover, não deletar. O que muda é onde o produto se apresenta — e que a tela **obedece à origem**: números de fatura para fatura, números de conta para conta.

## Funcionalidades

- autenticação por e-mail e senha com Firebase Auth;
- sessão SSR em cookie `httpOnly` verificado pelo Admin SDK;
- importação OFX e CSV de fatura e de conta, sem formulário de mapeamento no caminho normal;
- centavos inteiros, deduplicação por fingerprint e rollup por período, transacional;
- a fatura como unidade de período, e não o mês civil;
- revisão antes do envio ao Gemini, categorização em lotes e recuperação de pendências;
- correção de categoria **e de fluxo** que aprende uma regra para os próximos meses;
- tela de regras: ver, editar e apagar o que o app aprendeu;
- renda mensal opcional, para dizer quanto da renda a fatura consumiu;
- pizza clicável, filtros, comparação mensal, tendência de 6 meses e insights a partir de agregados;
- opt-out de IA por transação e exclusão completa da conta.

## Desenvolvimento

Requisitos: Node.js 20 ou superior e um projeto Firebase com Auth por e-mail/senha e Firestore.

```bash
npm install
copy .env.local.example .env.local
npm run dev
```

Preencha o `.env.local` com as configurações públicas do app Firebase, a conta de serviço do Admin SDK e, para usar IA, `GEMINI_API_KEY`.

Validação:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Os testes de isolamento e de persistência usam o Firebase real quando as variáveis de teste estão preenchidas. Crie as contas descartáveis com:

```bash
npm run seed:usuarios
```

## Conta demo

O seed nunca publica um extrato cru. Ele parte de uma **fatura de cartão** derivada (`tests/fixtures/derivadas/fatura-demo.ofx`), passa cada descrição pelo mesmo anonimizador da aplicação, classifica os fluxos com o mesmo classificador do import real, desloca as datas e multiplica os valores antes de gravar duas faturas. O seed falha se a cobertura de categorias cair abaixo dos 90% que a spec 003 §9 pede.

```bash
npm run seed:demo
```

Defina antes `NEXT_PUBLIC_DEMO_EMAIL`. O seed cria uma identidade com login Firebase **desativado** e senha aleatória que nunca é exposta. O script substitui somente a árvore desse usuário demo e imprime o `FIREBASE_DEMO_UID` para configurar no servidor.

A demonstração usa um marcador público no cookie, resolvido pelo servidor para essa única identidade, sempre com `demo: true`. Não há ID token, refresh token ou senha no navegador. As contas pessoais continuam com sessões Firebase verificadas.

Para uma demo existente que já publicou uma senha, execute no ambiente Firebase correspondente:

```bash
npm run migrar:demo
```

Essa migração **preserva os dados**, desativa o login, troca a senha antiga e revoga sessões Firebase. Configure o `FIREBASE_DEMO_UID` exibido, remova `NEXT_PUBLIC_DEMO_PASSWORD` das variáveis locais e da Vercel e publique a nova versão. Não use `seed:demo` para migrar dados existentes. O novo acesso recusa a demo enquanto o login antigo estiver habilitado. A alteração local do código, sozinha, não invalida credenciais já publicadas.

## Segurança e isolamento

Todos os dados pertencentes a uma pessoa vivem sob `users/{uid}`. As Security Rules permitem leitura apenas ao dono e negam qualquer escrita do SDK cliente. As escritas e validações ficam no servidor.

Há um limite importante: **o Firebase Admin SDK ignora as Security Rules**. No servidor, o isolamento vem da estrutura de `lib/firestore/repo.ts`: toda operação recebe `uid` como primeiro argumento e monta o caminho sob aquele usuário. Não existe uma consulta global de transações que dependa de lembrar um `where userId`.

O cookie de sessão é `httpOnly`, `sameSite=lax` e `secure` em produção. Nas contas pessoais, a assinatura e a revogação são verificadas nas páginas, Server Actions e Route Handlers que acessam dados. O marcador da demo só concede leitura à identidade fixada no servidor e não é aceito como autenticação pessoal.

## Privacidade e IA

O arquivo enviado é processado em memória e descartado ao fim da requisição; não há bucket de extratos. Importar não dispara IA. Em **Transações**, revise o mês, bloqueie os lançamentos sensíveis e clique em **Autorizar e categorizar pendências**. Se a chamada falhar, o mesmo botão permite tentar novamente, inclusive para imports antigos ou arquivos reimportados sem linhas novas.

Antes de qualquer chamada ao Gemini, o servidor remove CPF, CNPJ, agência, conta, sequências longas, telefone, e-mail, UUID e a contraparte de PIX/TED/DOC/transferência. O payload usa um ID opaco temporário, descrição anonimizada, data e valor em centavos. O vínculo entre ID e documento existe apenas em memória.

### O estabelecimento é o dado central, e não um efeito colateral

Esta é a troca que a spec 003 §2 torna explícita, e ela mudou de sentido quando o produto virou controlador de fatura.

Antes, o nome do estabelecimento **sobrava** no payload: era o resíduo que o anonimizador não tinha como remover sem inviabilizar a categorização. Agora ele é **a razão de a fatura funcionar melhor que a conta corrente** — é ele que carrega o sinal, e é ele que faz a métrica de ≥ 90% fora de `outros` ser atingível.

Isso não diminui o risco residual; ao contrário, coloca-o no centro. `DROGARIA SAO PAULO`, `CLINICA X`, `LABORATORIO Y`, o nome de um advogado ou de uma igreja revelam informação sensível — na LGPD, dado sobre saúde e sobre convicção religiosa é **dado pessoal sensível** (art. 5º, II).

O que o app faz a respeito:

- **importar não dispara IA.** Nada é enviado sem você clicar em **Autorizar e categorizar pendências**, e entre uma coisa e outra você vê a lista inteira;
- **bloqueio por transação** impede os próximos envios daquela linha; saídas ficam em `outros` e entradas em `receita`. Não desfaz chamadas já iniciadas;
- cada lote relê as permissões antes do envio, e a gravação confere a revisão da transação para preservar correções manuais feitas durante a espera.

Insights recebem somente totais por categoria do período atual e anterior, nunca linhas individuais. Dados enviados à Gemini podem ser processados pelo Google fora do Brasil; consulte os termos aplicáveis à modalidade da API usada.

### Cookies, medição e consentimento

**Este app usa um cookie só:** o de sessão (`sessao`, `httpOnly`, `sameSite=lax`), que mantém a pessoa logada. Ele não é lido por script, não vai para terceiros e não serve para publicidade. É estritamente necessário — sem ele não há como servir uma página autenticada —, então não depende de consentimento e não pode ser desligado. Sair da conta o remove.

**A medição é opcional e nasce desligada.** Com autorização, o app monta **Vercel Web Analytics** e **Vercel Speed Insights**. Nenhum dos dois usa cookie ou identificador persistente de visitante.

| | O que envia |
|---|---|
| Web Analytics | caminho, referrer, país, dispositivo, navegador, sistema |
| Speed Insights | caminho, rota, país, dispositivo, navegador, velocidade de conexão, Core Web Vitals |

Duas proteções, e elas resolvem coisas diferentes:

**1. O consentimento decide se o script existe.** Recusado — ou ainda não respondido —, os componentes não são renderizados: sem `<script>`, sem requisição. É bloqueio, não filtro. Um `beforeSend` devolvendo `null` teria carregado o script assim mesmo.

O padrão antes da resposta é **não medir**. É a leitura defensável da LGPD para tratamento que não é necessário ao serviço: a base legal precisa existir antes do tratamento. O preço é perder quem fecha a aba sem responder, e ele é aceito de propósito.

**2. O `beforeSend` corta a query string** do que é enviado por quem aceitou. As URLs deste app carregam os filtros da tela:

```
/transacoes?mes=2026-09&categoria=saude
```

Sem o corte, cada clique numa fatia da pizza mandaria à Vercel o sinal de que aquele visitante tem gasto com saúde — dado pessoal sensível na LGPD (art. 5º, II), vazando por um caminho onde nada dá erro. O corte é da query **inteira**, e não de uma lista de parâmetros proibidos: lista precisa ser lembrada a cada filtro novo, e é assim que o próximo vaza. Aceitar medição não é aceitar que o filtro viaje junto.

**Revogar é a qualquer momento**, em `/conta` → *Cookies e medição*. A mudança vale na hora, sem recarregar: o `<Medicao>` do layout escuta um evento e desmonta os scripts. A LGPD pede procedimento "gratuito e facilitado" para retirar consentimento (art. 8º, §5º), e deixar isso só num banner que aparece uma vez não cumpre "facilitado".

A escolha fica no `localStorage` **deste navegador**, não na conta: guardá-la no servidor exigiria identificar a pessoa para saber que ela não quer ser identificada. A chave é versionada (`medicao-consentimento-v1`) para que mudar o que se coleta invalide o consentimento dado sobre a coleta antiga.

Nenhum valor, descrição, categoria ou transação é enviado à Vercel, em hipótese nenhuma. O que é enviado, quando é, é processado fora do Brasil.

Onde isso mora: `lib/privacy/consentimento.ts` (o modelo, puro e testado), `lib/privacy/medicao.ts` (o corte da query), `components/analytics.tsx` (o portão e o banner), `app/(app)/conta/medicao.tsx` (a revogação).

## Importar não pergunta o que o arquivo já responde

Um CSV de extrato não tem formato padrão, então a versão anterior pedia à pessoa que descrevesse o dela: quatro seletores de coluna, um de formato de data, e a pergunta *"como o arquivo representa os valores?"*, com opções como `Cartão Nubank — positivo é compra`. Quem não trabalha com extrato não tem como responder isso, e era obrigatório para passar da tela.

Hoje o app responde sozinho e **mostra o resultado em vez de perguntar**:

```
Confira se entendi
17 lançamentos · 04/08 a 30/08

04/08  Mercado Extra Loja 88   Compra   −R$ 412,35
05/08  Ifd*Ifood Sao Paulo     Compra    −R$ 68,90
06/08  Padaria Bela Vista      Compra    −R$ 24,50

No total: 15 compras somando R$ 1.901,50, 1 estorno de R$ 249,80,
1 pagamento de R$ 1.200,00.
```

Colunas e formato de data já eram detectados (`inspecionar`). O que faltava era a convenção de sinal, e o arquivo a entrega: **numa fatura, compra é a maioria esmagadora das linhas**, então o sinal da maioria é o sinal da compra (`perfilSugerido`). Abaixo de 60% de maioria ele não chuta — errar aqui inverte todos os números do mês —, e aí a pergunta sobe para a pessoa.

A conferência é feita com **três lançamentos dela, já interpretados**. Reconhecer a própria compra qualquer um faz; descrever uma convenção de sinal, não. E as linhas saem da mesma lista que vai ser gravada, então provam o caminho inteiro.

O formulário continua existindo atrás de **"Algo está errado?"**, e abre sozinho quando o app de fato não sabe — dizendo qual informação falta. É lá que fica a opção de importar **extrato de conta corrente**, que a spec 003 §4 manda demover e não deletar: o app aceita os dois, mas só um deles é a proposta.

## A tela obedece à origem

Cartão não tem saldo. Um app que se anuncia como controlador de fatura e mostra "Saldo: −R$ 1.622" é, nas palavras da spec 003 §4, *pior que os dois produtos separados* — e aquele saldo sempre negativo era sintoma de tela, não de contabilidade.

| Origem | O que aparece |
|---|---|
| Fatura | Total da fatura, estornos, maior categoria, % da renda, pizza |
| Conta | Total gasto, recebido, transferências, saldo, maior categoria |

A origem de um período vem do rollup, que passou a contar quantas transações vieram de cada tipo de conta (`byAccountKind`) — uma leitura de documento, sem varrer o mês. **Basta uma linha de conta corrente para o período ser tratado como conta:** num período misto existe saldo de verdade, e a assimetria é de propósito. Períodos anteriores a esta versão, ou vazios, caem para a lista de contas; sem conta nenhuma, o padrão é fatura.

### Fatura e conta pararam de dividir o mesmo documento

Um CSV não traz id de conta. Antes, tanto uma fatura quanto um extrato de conta caíam em `Conta principal` — **o mesmo documento** —, e o `kind` dele passava a ser o do último import. O tipo mudava sozinho, e com ele a leitura da tela inteira.

Agora: o CSV de fatura vai para `Cartão principal`, o de conta para `Conta principal`, e **o `kind` só é escrito quando a conta nasce** — nenhum arquivo importado depois o reescreve.

A separação vem do nome, e não de hashear o tipo no id, de propósito: o `accountId` entra no fingerprint, então mexer no id daria identidade nova a toda transação já gravada e duplicaria o extrato inteiro no import seguinte.

**Uma consequência, se você já importou uma fatura em CSV antes desta versão:** aquelas transações estão sob `Conta principal`. Ao reimportar o mesmo arquivo, ele vai para `Cartão principal` e as linhas entram de novo, com identidade nova. Ou você não reimporta (o histórico continua lendo certo, só sob o nome errado), ou apaga o import antigo antes. Importação por OFX não é afetada — ela sempre teve id de conta próprio.

## A fatura como unidade de período

Compras de uma mesma fatura atravessam dois meses civis. Somá-las pelo calendário produz dois meios-totais que não correspondem a cobrança nenhuma.

Com o dia de fechamento configurado em **Conta**, o período de uma compra passa a ser o mês em que a fatura **fecha**:

```
fecha dia 3:   04/09 … 03/10   →   fatura de outubro
```

Uma compra de 28/09 numa fatura que fecha em 03/10 aparece na fatura de outubro.

**É opt-in por conta.** Sem dia de fechamento, o período continua sendo o mês civil — mudar a chave de agregação é a única operação do app capaz de corromper histórico, e ela não acontece sem alguém pedir.

**Dá para configurar antes da primeira importação**, e é o caminho que evita trabalho: a conta de cartão só nasce quando você importa, mas o fechamento pode ser declarado antes, em **Conta**. A conta herda o valor ao nascer e a primeira fatura já agrupa certo — sem migrar nada depois.

A precedência é **pessoa antes de arquivo**: o que a conta já tem ganha de tudo; depois o que você declarou no perfil; por último o `DTEND` de um OFX de cartão, que é um palpite bom mas ainda é palpite. A tela diz de onde o valor veio.

⚠️ **Fechamento não é vencimento**, e vários bancos nomeiam o arquivo exportado pela data de **vencimento**. No Nubank, `Nubank_2026-09-13.csv` vence dia 13 e fecha dia 5 — usar o 13 parte cada fatura em dois meses. Confira na própria fatura, ou olhe o intervalo de datas que a tela de importação mostra: se ele vai do dia 6 ao dia 5, o fechamento é 5.

Um `periodEnd` **nunca** vira sugestão de fechamento. Isso custou um defeito: `periodEnd` é a última data observada, e num CSV isso é a última compra — uma fatura que fecha dia 5 com última compra dia 3 configurava fechamento no dia 3, e a partir daí cada importação reparticionava tudo em torno de uma data inventada, inclusive jogando lançamentos num mês que ninguém importou.

Configurar o fechamento afeta as **próximas** importações. Para mover o que já está gravado:

```bash
npm run migrar:faturas -- --email=voce@exemplo.com
npm run migrar:faturas -- --email=voce@exemplo.com --apply --project=<id-do-firebase>
```

Sem `--apply` ele só imprime o que faria: quantas transações mudam de período, para quais faturas, e os totais projetados. Com `--apply`, exige `--project` (para falhar se o ambiente carregado não for o que você pensa), salva backup em `.local-backups/`, move as transações, recalcula os rollups afetados — **os de origem e os de destino** —, apaga os insights daqueles períodos, e então **relê tudo do banco e confere campo a campo**. Se divergir, o comando sai com erro e aponta o backup. Antes de escrever, ele também confere que a soma das transações não mudou: reparticionar não cria nem destrói dinheiro.

## Regras: o app aprende, e você vê o que ele aprendeu

Em `/regras`, cada correção sua que veio com um padrão aparece com o padrão, a categoria, o fluxo (quando houver) e quantas vezes foi usada. Dá para **editar a categoria** e **apagar**.

Isso fecha um defeito real: antes, uma correção errada virava regra, a regra reaplicava a categoria errada em todo import seguinte, e não havia caminho de volta — nem para ver, nem para apagar. Apagar não reverte o que já foi categorizado (aquilo virou dado); o que muda é que a regra deixa de ser aplicada daqui para a frente. **Uma por vez, sem ação em lote**, porque não existe desfazer.

## Corrigir o tipo de um lançamento

O classificador acerta a maioria e erra o resto em silêncio. `PAG*NOMEDALOJA` é uma maquininha, não pagamento de fatura — e só você sabe.

No painel que abre em cada linha, **O que é este lançamento** move a transação entre compra, entrada, estorno e pagamento/transferência. Mover entre esses tipos mexe em três totais diferentes, e o rollup é ajustado na mesma transação do Firestore: as três leituras continuam fechando (`bruto − estornos = líquido`), conferidas campo a campo contra `recalcularRollup()`.

Com um padrão preenchido, a correção **vira regra** e é aplicada já no import seguinte — antes de qualquer chamada à IA, e portanto sem gastar token.

## Fatura de cartão e o sinal do valor

O sinal escrito no arquivo não tem significado universal. Em conta corrente, positivo é entrada. No CSV da fatura do Nubank, **positivo é compra** e negativo é crédito ou pagamento. Importar uma fatura com a convenção de conta corrente inverte todos os números do mês.

Por isso o CSV exige escolher o tipo de extrato na tela de importação, e o OFX deduz pelo tipo de conta que o próprio arquivo declara. O valor bruto é sempre gravado como veio; o que a escolha define é o `flowType`, que decide como aquela linha participa dos totais:

| `flowType` | O que é | Entra onde |
|---|---|---|
| `expense` | compra, despesa | gasto bruto da categoria |
| `income` | salário, entrada | receita |
| `refund` | estorno, devolução, crédito | abate o gasto, na categoria dele |
| `transfer` | pagamento de fatura, aplicação e resgate de investimento, Pix no crédito | em nenhum dos dois — só no próprio total |

Pagamento de fatura é **transferência entre contas**, não gasto nem renda: contá-lo como despesa somaria a fatura inteira por cima das compras que ela paga. O reconhecimento é por descrição (`PAGTO FATURA`, `Pagamento recebido`, `PAYMENT - THANK YOU`) e só é consultado do lado do crédito, para que um estabelecimento chamado `PAG*ALGUMA LOJA` nunca saia dos gastos.

Antes de confirmar, a tela mostra uma **prévia** com a contagem por tipo. Ela percorre o mesmo parser do import real e não grava nada — existe para a inversão de sinal aparecer antes, e não depois.

### As três leituras de gasto

O rollup guarda gasto e estorno **separados por categoria**, e as três leituras fecham entre si:

```
gasto bruto − estornos = gasto líquido
```

O gasto bruto é, por construção, a soma das fatias da pizza. Quando um estorno cai num mês sem despesa correspondente na mesma categoria — comprar em agosto e a devolução chegar em setembro —, é a separação que impede a pizza de somar um valor e o card mostrar outro. O gasto líquido **pode ser negativo**: num mês em que a devolução supera a compra, o dinheiro voltou, e esconder isso atrás de um zero seria perder a informação.

### Movimentação interna de conta corrente

Extrato de conta não é lista de compras. Tratar todo negativo como gasto produz números grosseiramente falsos: num extrato real medido aqui, **87% dos "gastos" não eram gasto** — R$ 1.622 de fatura de cartão e R$ 432 de aplicação em investimento, contra R$ 307 de despesa de verdade.

Por isso estes padrões viram `transfer` também em conta corrente, e saem do resultado do mês:

- `Pagamento de fatura` / `PAGTO FATURA` — a fatura quita compras que, se você importar o extrato do cartão, já estão contadas;
- `Aplicação …` e `Resgate …` — dinheiro indo para o investimento e voltando dele;
- `Valor adicionado na conta por cartão de crédito` — o "Pix no crédito" entra e sai no mesmo instante.

**O ambíguo fica de fora, de propósito.** `Transferência enviada pelo Pix` para uma pessoa continua despesa: pagar o aluguel por Pix é gasto, mandar dinheiro para si mesmo não é, e o extrato não distingue. Chutar "transferência" esconderia gasto real — errar para menos é o lado que ninguém audita. `PAGAMENTO DE BOLETO` também continua despesa, porque é conta paga.

### Descrição sem sinal não vai à IA

`Transferência enviada pelo Pix - FULANO - •••.123.456-•• - BANCO …` vira exatamente **`Transferência`** depois do anonimizador, porque a contraparte é dado pessoal e sai antes de qualquer chamada. Uma palavra não vira categoria: essas linhas recebem `outros` de forma determinística, sem gastar chamada paga para comprar uma resposta que já se conhece. No extrato medido eram 9 das 16 despesas.

### Corrigir faturas importadas antes disso

Transações gravadas antes desta versão não têm `flowType` e foram interpretadas pela convenção de conta corrente. O script abaixo reclassifica **apenas os arquivos que você nomear**, e roda em modo simulação por padrão:

```bash
npm run repair:card-flows -- --email=voce@exemplo.com --file=fatura.csv   --profile=credit_card_positive_expenses
```

**`--profile` é obrigatório e o script não adivinha.** Só quem exportou o arquivo sabe que arquivo é aquele; a versão anterior deduzia do formato — todo CSV virava fatura de cartão — e passada num extrato de conta corrente reclassificava **todas** as despesas como estorno, o que as tirava da fila de pendentes de vez.

Duas travas fecham o resto:

- se mais da metade das transações virar estorno, o comando **para**. Essa distribuição é a assinatura do perfil errado, porque num extrato de verdade estorno é exceção. `--aceito-a-distribuicao` passa por cima, se for mesmo o caso;
- `--apply` exige `--project=<id-do-firebase>`, para o comando falhar se o ambiente carregado não for o que você pensa.

Ele imprime o que faria — contagem por tipo e os totais projetados de cada mês — e só escreve com `--apply`. Antes de escrever, salva um backup em `.local-backups/` (ignorado pelo git, contém dados reais), recalcula os rollups do mês inteiro e apaga os insights daqueles meses, gerados sobre os números antigos.

### Devolver transações à fila da IA

`--recategorizar` zera a categoria do que foi **decidido pela IA** sobre um valor com o sinal errado, para que a categorização rode de novo:

```bash
npm run repair:card-flows -- --email=voce@exemplo.com --file=extrato.csv   --profile=bank_account --recategorizar
```

Escolha manual sua e regra que você criou não são tocadas — aquilo é dado, não palpite. Sem esta opção não existe caminho de volta: assim que `category` deixa de ser nulo, a transação nunca mais é pendente, e o palpite errado fica gravado para sempre.

## Exclusão da conta

Em `/conta`, a confirmação `EXCLUIR` executa `recursiveDelete` na árvore `users/{uid}`, depois remove o usuário do Firebase Auth e encerra o cookie de sessão. O uso de `recursiveDelete` é necessário porque excluir apenas o documento pai no Firestore não apaga subcoleções.

## Deploy na Vercel

1. Crie um projeto Firebase separado para produção e publique `firestore.rules` e `firestore.indexes.json`.
2. Importe o repositório na Vercel.
3. Cadastre na Vercel todas as variáveis descritas em `.env.local.example`, usando credenciais do projeto de produção.
4. Não exponha `FIREBASE_PRIVATE_KEY` ou `GEMINI_API_KEY` com prefixo `NEXT_PUBLIC_`.
5. Para uma demo nova, rode `npm run seed:demo` no ambiente de produção e configure o UID retornado. Para a existente, use `npm run migrar:demo`, que preserva os dados.
6. Teste login, importação, opt-out e exclusão com uma conta que não seja a demo.
7. Habilite **Web Analytics** e **Speed Insights** no painel da Vercel. Os componentes já estão no layout, atrás do consentimento; sem habilitar no painel, nada é coletado mesmo com autorização.

O modelo padrão é `gemini-3.6-flash`, com suporte a structured output. Ele pode ser trocado por `GEMINI_MODEL` sem alterar o código.

## Estrutura principal

- `app/api/imports`: parsing, regras de fluxo e persistência;
- `app/api/categorize`: regras, lotes e Gemini;
- `app/api/insights`: cache e geração por agregado;
- `app/(app)/regras`: ver, editar e apagar o que o app aprendeu;
- `app/(app)/tendencia`: N rollups lidos sob demanda, sem agregado novo;
- `lib/domain/account`: tipo da conta e a origem que a tela obedece;
- `lib/domain/invoice`: a fatura como período, e o dia de fechamento;
- `lib/domain/renda`: o denominador do percentual, e por que `null` não é zero;
- `lib/privacy`: fronteira de anonimização;
- `lib/llm`: abstração do provedor, schemas e Gemini;
- `lib/firestore`: único acesso servidor ao Firestore;
- `lib/privacy/consentimento.ts`: o que a medição pode fazer, e quando;
- `components/analytics.tsx`: o portão do consentimento e o banner;
- `tests`: parsers, dinheiro, fingerprint, privacidade, IA, rollup, fatura e isolamento.

## Specs

- `specs/001-v1.md` — o que foi construído, e continua valendo;
- `specs/002-open-finance.md` — a segunda fonte, aprovada e não iniciada;
- `specs/003-cartao.md` — o pivô para controlador de fatura, **implementada**;
- `specs/004-multi-cartao.md` — mais de um cartão, com banco e final do número. **Rascunho, não aprovada.**

## Licença

[MIT](LICENSE). Use, copie e modifique à vontade; a única obrigação é manter o aviso de copyright.

O que a licença cobre é **o código**. Ela não dá direito sobre a marca do projeto nem sobre os dados de qualquer instância em produção, e — como diz a cláusula de garantia, em letra maiúscula e em inglês jurídico — o software é fornecido **como está**. Vale repetir em português, porque aqui se trata de dinheiro de verdade: este é um projeto pessoal, sem garantia de disponibilidade, e não substitui o extrato oficial do seu banco.
