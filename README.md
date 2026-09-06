# Dashboard Financeiro

Aplicação em Next.js para importar extratos OFX/CSV, categorizar gastos com IA e visualizar o mês sem entregar dados bancários crus a terceiros.

Produção: https://dashboard-financeiro-ia.vercel.app

## Funcionalidades

- autenticação por e-mail e senha com Firebase Auth;
- sessão SSR em cookie `httpOnly` verificado pelo Admin SDK;
- importação OFX e CSV com mapeamento de colunas;
- centavos inteiros, deduplicação por fingerprint e rollup mensal transacional;
- revisão antes do envio ao Gemini, categorização em lotes e recuperação de pendências;
- correção manual que aprende uma regra para os próximos meses;
- pizza clicável, filtros, comparação mensal e insights a partir de agregados;
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

O seed nunca publica um extrato cru. Ele parte de uma fixture derivada, passa cada descrição pelo mesmo anonimizador da aplicação, desloca as datas e multiplica os valores antes de gravar dois meses:

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

O nome do estabelecimento permanece porque é necessário para categorizar. Isso deixa um risco residual: nomes de clínicas, farmácias ou advogados podem revelar informação sensível. O bloqueio por transação impede próximos envios; saídas ficam em `outros` e entradas em `receita`. Isso não desfaz chamadas já iniciadas. Cada lote relê as permissões antes do envio e a gravação confere a revisão da transação para preservar correções manuais feitas durante a espera.

Insights recebem somente totais por categoria do mês atual e anterior, nunca linhas individuais. Dados enviados à Gemini podem ser processados pelo Google fora do Brasil; consulte os termos aplicáveis à modalidade da API usada.

## Fatura de cartão e o sinal do valor

O sinal escrito no arquivo não tem significado universal. Em conta corrente, positivo é entrada. No CSV da fatura do Nubank, **positivo é compra** e negativo é crédito ou pagamento. Importar uma fatura com a convenção de conta corrente inverte todos os números do mês.

Por isso o CSV exige escolher o tipo de extrato na tela de importação, e o OFX deduz pelo tipo de conta que o próprio arquivo declara. O valor bruto é sempre gravado como veio; o que a escolha define é o `flowType`, que decide como aquela linha participa dos totais:

| `flowType` | O que é | Entra onde |
|---|---|---|
| `expense` | compra, despesa | gasto bruto da categoria |
| `income` | salário, entrada | receita |
| `refund` | estorno, devolução, crédito | abate o gasto, na categoria dele |
| `transfer` | pagamento da fatura | em nenhum dos dois — só no próprio total |

Pagamento de fatura é **transferência entre contas**, não gasto nem renda: contá-lo como despesa somaria a fatura inteira por cima das compras que ela paga. O reconhecimento é por descrição (`PAGTO FATURA`, `Pagamento recebido`, `PAYMENT - THANK YOU`) e só é consultado do lado do crédito, para que um estabelecimento chamado `PAG*ALGUMA LOJA` nunca saia dos gastos.

Antes de confirmar, a tela mostra uma **prévia** com a contagem por tipo. Ela percorre o mesmo parser do import real e não grava nada — existe para a inversão de sinal aparecer antes, e não depois.

### As três leituras de gasto

O rollup guarda gasto e estorno **separados por categoria**, e as três leituras fecham entre si:

```
gasto bruto − estornos = gasto líquido
```

O gasto bruto é, por construção, a soma das fatias da pizza. Quando um estorno cai num mês sem despesa correspondente na mesma categoria — comprar em agosto e a devolução chegar em setembro —, é a separação que impede a pizza de somar um valor e o card mostrar outro. O gasto líquido **pode ser negativo**: num mês em que a devolução supera a compra, o dinheiro voltou, e esconder isso atrás de um zero seria perder a informação.

### Limitação conhecida

Se você importar **a conta corrente e a fatura do mesmo cartão**, o pagamento da fatura aparece como transferência no extrato do cartão, mas como despesa no da conta corrente — e as compras da fatura já estão contadas. O gasto do mês fica somado duas vezes. Hoje o app não reconcilia lançamentos entre contas; importe um ou o outro.

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

O modelo padrão é `gemini-3.6-flash`, com suporte a structured output. Ele pode ser trocado por `GEMINI_MODEL` sem alterar o código.

## Estrutura principal

- `app/api/imports`: parsing e persistência;
- `app/api/categorize`: regras, lotes e Gemini;
- `app/api/insights`: cache e geração por agregado;
- `lib/privacy`: fronteira de anonimização;
- `lib/llm`: abstração do provedor, schemas e Gemini;
- `lib/firestore`: único acesso servidor ao Firestore;
- `tests`: parsers, dinheiro, fingerprint, privacidade, IA, rollup e isolamento.
