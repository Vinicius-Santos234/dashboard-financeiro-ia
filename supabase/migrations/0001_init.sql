-- 0001_init.sql — schema inicial do Dashboard Financeiro
-- Spec: specs/001-v1.md §4
--
-- Duas coisas nesta migration não são detalhe e estão comentadas onde aparecem:
--   1. dinheiro é bigint em centavos, nunca float  (§4.2, D9)
--   2. toda policy tem `with check`, não só `using` (§4.4)

-- ---------------------------------------------------------------------------
-- Enum de categorias — fechado. §4.1
-- ---------------------------------------------------------------------------
create type categoria as enum (
  'alimentacao',
  'transporte',
  'moradia',
  'saude',
  'lazer',
  'educacao',
  'compras',
  'contas_fixas',
  'receita',
  'outros'
);

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
create table public.accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  institution text,
  kind        text not null check (kind in ('checking', 'savings', 'credit_card')),
  created_at  timestamptz not null default now()
);

create index accounts_user_idx on public.accounts (user_id);

-- ---------------------------------------------------------------------------
-- imports — um registro por arquivo processado
-- ---------------------------------------------------------------------------
create table public.imports (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  account_id      uuid references public.accounts (id) on delete set null,
  source          text not null check (source in ('ofx', 'csv')),
  filename        text not null,
  -- sha256 do arquivo. Não é unique de propósito: reimportar é legítimo, e quem
  -- impede a linha duplicada é transactions.fingerprint. Este campo só permite
  -- avisar "você já importou este arquivo em <data>".
  file_hash       text not null,
  period_start    date,
  period_end      date,
  rows_total      integer not null default 0 check (rows_total >= 0),
  rows_imported   integer not null default 0 check (rows_imported >= 0),
  rows_duplicated integer not null default 0 check (rows_duplicated >= 0),
  status          text not null check (status in ('parsed', 'categorized', 'failed')),
  error           text,
  created_at      timestamptz not null default now()
);

create index imports_user_created_idx on public.imports (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------
create table public.transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  account_id        uuid not null references public.accounts (id) on delete cascade,
  import_id         uuid references public.imports (id) on delete set null,

  occurred_on       date not null,

  -- CENTAVOS. bigint, nunca numeric/float: float erra centavo e o erro só
  -- aparece quando a soma das fatias do gráfico não bate com o extrato.
  -- Negativo = saída, positivo = entrada.
  amount_cents      bigint not null,

  description_raw   text not null,  -- como veio do banco; nunca sai do servidor
  description_clean text not null,  -- anonimizada (§7.1); é esta que vai à LLM

  fitid             text,           -- id do banco, quando o OFX traz
  fingerprint       text not null,  -- §4.3

  category          categoria,
  category_source   text check (category_source in ('ai', 'rule', 'user')),
  confidence        numeric(3, 2) check (confidence between 0 and 1),

  -- 'bot' e 'openfinance' já existem aqui de propósito: custam uma linha hoje
  -- e evitam uma migration quando entrarem (§3 D5, fora de escopo §2).
  source            text not null default 'ofx'
                    check (source in ('ofx', 'csv', 'bot', 'openfinance')),

  -- Marcada pelo usuário: nunca enviar à LLM. Fica em 'outros'. (§7.2)
  ai_opt_out        boolean not null default false,

  created_at        timestamptz not null default now(),

  -- A garantia de que reimportar o mesmo extrato não dobra o gráfico.
  constraint transactions_fingerprint_unique unique (user_id, fingerprint),

  -- Categoria e origem da categoria andam juntas ou não andam.
  constraint transactions_category_coerente check (
    (category is null and category_source is null)
    or (category is not null and category_source is not null)
  )
);

create index transactions_user_date_idx on public.transactions (user_id, occurred_on desc);
create index transactions_user_category_idx on public.transactions (user_id, category);
create index transactions_pendentes_idx on public.transactions (user_id)
  where category is null;

-- ---------------------------------------------------------------------------
-- rules — a correção do usuário virando cache
-- ---------------------------------------------------------------------------
create table public.rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  pattern    text not null check (length(btrim(pattern)) >= 3),
  category   categoria not null,
  hits       integer not null default 0,
  created_at timestamptz not null default now(),
  constraint rules_pattern_unique unique (user_id, pattern)
);

create index rules_user_idx on public.rules (user_id);

-- ---------------------------------------------------------------------------
-- insights — um por mês, cacheado
-- ---------------------------------------------------------------------------
create table public.insights (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  period       date not null,  -- sempre dia 1 do mês
  body         jsonb not null,
  model        text not null,
  generated_at timestamptz not null default now(),
  constraint insights_period_unique unique (user_id, period),
  constraint insights_period_dia_1 check (extract(day from period) = 1)
);

-- ---------------------------------------------------------------------------
-- RLS — o mecanismo, não a promessa. §4.4
--
-- `using` protege a LEITURA. `with check` protege a ESCRITA.
-- Sem `with check`, um usuário autenticado consegue INSERIR uma linha com o
-- user_id de outro — o select fica correto e o buraco passa despercebido.
-- ---------------------------------------------------------------------------
alter table public.accounts     enable row level security;
alter table public.imports      enable row level security;
alter table public.transactions enable row level security;
alter table public.rules        enable row level security;
alter table public.insights     enable row level security;

create policy "own rows only" on public.accounts
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows only" on public.imports
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows only" on public.transactions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows only" on public.rules
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows only" on public.insights
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- `to authenticated` deixa o papel `anon` sem policy nenhuma: quem não fez
-- login não lê nem escreve nada, em vez de depender de auth.uid() ser null.
--
-- (select auth.uid()) em vez de auth.uid() puro: o Postgres avalia o subselect
-- uma vez por query em vez de uma vez por linha. Em tabela de extrato isso é a
-- diferença entre um index scan e um scan linha a linha.
