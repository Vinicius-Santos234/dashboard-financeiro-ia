# Spec 002 — Open Finance como segunda fonte

**Status:** aprovada, não iniciada
**Data:** 2026-09-05
**Depende de:** `specs/001-v1.md` (todas as etapas concluídas)

---

## 1. Objetivo

Ler transações direto do banco por Open Finance, sem arquivo no meio, e fazer
essas transações entrarem pelo **mesmo pipeline** que o OFX e o CSV já usam:
fingerprint, deduplicação, rollup transacional, anonimização e categorização.

**Uma frase de sucesso:** eu conecto minha conta uma vez e, daí em diante, o
dashboard fica atualizado sozinho — sem eu exportar nada.

---

## 2. A pesquisa que a spec 001 pediu e nunca foi feita

A spec 001 listou como próximo passo: *"conferir na prática o que Pluggy e Belvo
exigem — pesquisa de uma hora que pode mudar o projeto inteiro"*. Foi feita
agora, e **mudou**.

| O que a 001 supunha | O que é |
|---|---|
| "Passa por cadastro e, em geral, por aprovação" | **Falso para o sandbox.** Cadastro imediato, sem aprovação e sem cartão |
| "Dá para empacar no passo 1" | Não no sandbox. O bloqueio é **outro**, e é pior: preço |
| Sandbox como plano B | Sandbox **não conecta banco real** — é dado fictício |

**O bloqueio real são os preços de produção:**

| Provedor | Produção |
|---|---|
| Pluggy | a partir de **R$ 2.500/mês** |
| Belvo | mais caro que a Pluggy (relatos da comunidade: ~R$ 6.000/mês) |
| Tecnospeed | R$ 1.500 de entrada + R$ 540/mês |

O trial da Pluggy é de **14 dias** com API completa; depois as conexões reais
pausam e a configuração fica guardada por 30 dias. Não existe tier gratuito
permanente para uso comercial em nenhum dos três.

### O que destrava o projeto: "Meu Pluggy"

A Pluggy tem um produto separado, o **Meu Pluggy**, e ele muda tudo:

- **Gratuito por tempo indeterminado**, sem prazo de expiração
- Dá **Client ID e Client Secret** de verdade, pelo Dashboard
- **Sem limite de conexões**, desde que todas as contas sejam **suas, nominais**
- **Uso pessoal apenas** — uso comercial exige o plano pago

Ou seja: exatamente a forma deste projeto, que é um dashboard das **minhas**
finanças. O que era "o degrau que pode travar tudo" virou o caminho gratuito e
permanente.

---

## 3. Decisões travadas

| # | Decisão | Escolha | Motivo |
|---|---|---|---|
| E1 | Provedor | **Pluggy** | Único com acesso gratuito permanente à API (Meu Pluggy). Belvo e Tecnospeed só têm sandbox de teste |
| E2 | Credenciais reais | **Meu Pluggy**, contas do dono | Grátis, sem expiração, sem limite de conexões |
| E3 | Testes automatizados | **Sandbox da Pluggy** | Dado fictício em formato real; não gasta requisição de produção |
| E4 | Quem pode conectar | **Só a conta do dono**, por allowlist | Ver §7 — não é escolha de produto, é a licença |
| E5 | Sincronização | **Sob demanda + webhook**, nunca polling | Cada leitura da API é uma requisição cobrada |
| E6 | Identidade da transação | `id` da Pluggy, como o FITID do OFX | Mesma família do que já existe (§4.3 da 001) |
| E7 | Onde o segredo mora | Só no servidor, nunca no cliente | O `connectToken` do widget é emitido pelo servidor e é de vida curta |

---

## 4. O que a spec 001 prometeu e só é meia verdade

A 001 diz, sobre o `SourceAdapter`:

> *"quando o Open Finance entrar, ele implementa `SourceAdapter` e **nada mais
> no app muda**"*

**Metade disso se confirma, e a outra metade não.** Vale corrigir aqui em vez de
descobrir no meio da implementação.

**O que de fato se reaproveita inteiro** — e é a maior parte do valor:
`atribuirFingerprints`, `separarDuplicadas`, `gravarTransacoes` com o rollup na
mesma transação, `anonymize`, `planejarCategorizacao`, as regras do usuário, o
dashboard. Nada disso muda uma linha.

**O que não encaixa:** a forma da ingestão.

```ts
// O que existe (arquivo): empurrado, uma vez, sem estado
parse(bytes) → RawTransaction[]

// O que o Open Finance é: puxado, contínuo, com estado
sincronizar(conexão, desde) → RawTransaction[]
```

Arquivo é **push sem memória**. Open Finance é **pull com memória**: existe uma
conexão persistente, ela tem status (ativa, precisa de nova autenticação,
revogada), e cada sincronização precisa saber de quando em diante buscar.

Forçar isso na assinatura de `SourceAdapter` exigiria um `input` fingido e um
lugar para guardar o estado por fora — é o tipo de encaixe que parece
reaproveitamento e vira dívida. A decisão: **um irmão, não uma subclasse**.

```ts
export interface SyncAdapter {
  readonly id: 'openfinance'
  sincronizar(conexao: Conexao, desde: string | null): Promise<ParseResult>
}
```

`ParseResult` é o mesmo — é ele que faz os dois caminhos convergirem no
pipeline comum, e é onde o desacoplamento da 001 realmente pagou.

---

## 5. Modelo de dados

Uma coleção nova, no mesmo padrão de §4.1 da 001:

```
users/{uid}/connections/{itemId}
```

```ts
type Conexao = {
  provider: 'pluggy'
  itemId: string              // id do Item na Pluggy
  institution: string
  status: 'ativa' | 'reautenticar' | 'revogada' | 'erro'
  statusDetalhe: string | null
  accountIds: string[]        // contas nossas ligadas a esta conexão
  ultimaSync: string | null   // ISO; ponto de partida da próxima
  criadaEm: Timestamp
}
```

**`ultimaSync` é o que evita pagar duas vezes pelo mesmo dado.** Sem ele, cada
sincronização buscaria o histórico inteiro — e cada leitura é uma requisição
cobrada.

**Fingerprint:** `pf_` + sha256(accountId | id da transação na Pluggy). Mesma
lógica do `ofx_` (§4.3 da 001), inclusive a decisão de ser sempre hash, porque
id de documento não pode conter `/`.

> **Atenção ao que já mordeu antes:** a Pluggy pode reemitir uma transação
> pendente com id diferente quando ela é confirmada. O critério de aceite da E3
> cobre isso explicitamente — é a mesma família do FITID repetido, que já
> custou uma linha legítima descartada.

As regras do Firestore continuam **negando toda escrita de cliente**. A
`connections` nasce sob a mesma regra, sem exceção.

---

## 6. Arquitetura

```
app/(app)/conectar/page.tsx      widget da Pluggy, e a lista de conexões
app/api/pluggy/token/route.ts    emite o connectToken (curto, por usuário)
app/api/pluggy/webhook/route.ts  recebe aviso de dado novo
app/api/pluggy/sync/route.ts     sincroniza sob demanda
lib/sources/pluggy.ts            SyncAdapter
lib/pluggy/client.ts             cliente HTTP, credenciais server-only
```

**O fluxo de conexão**, e por que cada peça existe:

1. A tela pede um `connectToken` ao servidor. **O Client Secret nunca sai do
   servidor** — o token é de vida curta e escopo restrito.
2. O widget da Pluggy abre, a pessoa autentica no banco **dentro do fluxo
   regulado do Open Finance**. Nós nunca vemos a senha do banco.
3. A Pluggy devolve um `itemId`. Gravamos a conexão.
4. Sincronizamos: puxa transações desde `ultimaSync`, converte para
   `RawTransaction[]`, e daí em diante **é o pipeline que já existe**.

**O webhook** avisa quando há dado novo, em vez de perguntarmos de tempos em
tempos. Precisa de duas coisas para não virar buraco: **verificação de
assinatura** e **idempotência** — o mesmo evento pode chegar duas vezes, e a
dedupe por fingerprint já cobre a segunda.

---

## 7. A restrição de licença, que é uma decisão de produto

O Meu Pluggy é **uso pessoal**. Isso tem uma consequência que não dá para
contornar com engenharia:

> **Se um estranho se cadastrar no app e conectar o banco dele, isso deixa de
> ser uso pessoal.** Seria uso comercial com credencial gratuita — quebra de
> termos, e o tipo de coisa que não se resolve pedindo desculpas depois.

Portanto:

- **A conexão de Open Finance é liberada apenas para a conta do dono**, por uma
  allowlist de uid em variável de ambiente. Toda outra conta vê a tela com uma
  explicação honesta do porquê.
- **A conta demo pública nunca conecta banco nenhum.** Ela segue com o seed
  derivado, e o README explica que Open Finance está implementado e é
  demonstrado com dado derivado — porque a licença gratuita é pessoal.

Isso é chato de escrever e é o que separa "projeto de portfólio honesto" de
"projeto que quebra os termos de um fornecedor para ficar bonito na
apresentação". A limitação declarada vale mais que a demonstração fingida.

---

## 8. Fora de escopo

| Fora | Por quê |
|---|---|
| Iniciação de pagamento | Outro produto, outro preço, e o app não movimenta dinheiro |
| Investimentos | Continua fora, como na 001 |
| Belvo ou Tecnospeed como segundo provedor | O `SyncAdapter` deixa a porta aberta; sem motivo para abrir agora |
| Conexão para outros usuários | Ver §7. Só com plano pago |
| Sincronização automática por agendamento | Webhook cobre o caso real. Cron seria requisição paga a cada disparo |

---

## 9. Etapas e critério de aceite

### F1 — Cliente e sandbox, sem UI
- [ ] `lib/pluggy/client.ts` autentica e lista conectores
- [ ] Credenciais em env server-only, ausentes do bundle
- **Aceite:** um teste de integração conecta ao **sandbox** e lista transações
  fictícias. Roda com credencial; pula com aviso quando não houver, como o
  `isolamento.test.ts` já faz.

### F2 — `SyncAdapter` e conversão
- [ ] `lib/sources/pluggy.ts` devolve `ParseResult`
- [ ] Valor convertido para **centavos inteiros** e data no fuso do banco
- **Aceite:** sobre uma resposta fixa do sandbox, a soma dos `amountCents` bate
  ao centavo com a soma dos valores originais. Nenhum `float` no caminho.
- **Aceite:** transação de cartão de crédito entra com sinal correto.

### F3 — Fingerprint e dedupe
- [ ] `pf_` + hash, e a conexão no lugar do arquivo
- **Aceite:** sincronizar duas vezes seguidas grava **0 na segunda**, e o rollup
  **não muda** — o mesmo critério que fechou a E2 da 001.
- **Aceite:** uma transação pendente que é **reemitida com id novo** ao ser
  confirmada não entra duas vezes. Este é o caso que a família do FITID
  repetido já ensinou a temer.

### F4 — Conexão e widget
- [ ] `/api/pluggy/token` emite `connectToken` só para uid na allowlist
- [ ] Tela lista conexões com status legível
- **Aceite:** o Client Secret **não aparece** em nenhum arquivo do bundle
  servido. Verificado como em §10, buscando nos chunks.
- **Aceite:** uma conta fora da allowlist recebe 403 com a explicação de §7, não
  um erro genérico.

### F5 — Webhook
- [ ] Assinatura verificada; evento sem assinatura válida é recusado
- [ ] Idempotente
- **Aceite:** o mesmo evento entregue duas vezes resulta em **uma** gravação.
- **Aceite:** um evento com assinatura inválida é recusado e registrado.

### F6 — Ligação com o resto
- [ ] Transações sincronizadas entram na categorização e no dashboard
- [ ] `source: 'openfinance'` gravado (o campo já existe desde a 001)
- **Aceite:** uma transação vinda do Open Finance é anonimizada antes de
  qualquer chamada à LLM — a suíte de §7.3 da 001 roda também sobre a saída do
  `SyncAdapter`.
- **Aceite:** o dashboard soma arquivo e Open Finance na mesma pizza, sem
  duplicar nada.

---

## 10. Riscos

| Risco | Mitigação |
|---|---|
| Trial de 14 dias acabar no meio do desenvolvimento | O Meu Pluggy é a credencial principal; o trial não é usado |
| Uso do Meu Pluggy ser interpretado como comercial | Allowlist de §7, e o README dizendo o que é |
| Cada leitura ser cobrada | `ultimaSync` sempre; webhook em vez de polling; sem cron |
| A Pluggy mudar de política de gratuidade | O `SyncAdapter` isola o provedor. Se cair, o app volta a ser OFX/CSV — que continua funcionando |
| Reautenticação periódica do Open Finance | Status na conexão e aviso na tela; o regulado exige renovação de consentimento |
| Webhook público como superfície nova | Assinatura verificada, idempotência, e nenhuma ação destrutiva vinda dele |

---

## 11. Pendências

- [ ] Criar a conta no Meu Pluggy e obter Client ID/Secret
- [ ] Confirmar se o Meu Pluggy dá acesso aos **conectores de sandbox** ou só aos
      reais — muda a F1, e é a primeira coisa a verificar
- [ ] Ler os termos do Meu Pluggy na íntegra antes da F4, para o texto de §7 do
      README citar o que eles dizem, e não o que eu entendi

---

## 12. Referências

- Preços Pluggy — https://www.pluggy.ai/precos
- Meu Pluggy — https://www.pluggy.ai/meu-pluggy
- Sandbox Belvo — https://developers.belvo.com/pt-br/developer_resources/resources-sandbox
- Planos Belvo — https://belvo.com/plans-and-pricing/
- Discussão de custo real no Brasil — https://www.tabnews.com.br/GuilhermeVieira/estou-desenvolvendo-um-app-de-financas-pessoais-e-nao-consigo-pagar-o-open-finance-pluggy-r2-5k-mes-belvo-r6k-mes-tecnospeed-r1-5k-de-entrada-r540
