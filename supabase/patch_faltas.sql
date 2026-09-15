-- Patch pontual: so a tabela public.faltas (modulo Faltas VG).
-- Nao toca em funcoes, nem em outros modulos. Pode rodar sozinho, e idempotente.
--
-- Causa: a tabela ja existia no banco sem algumas colunas, e o
-- "create table if not exists" do schema.sql nunca as criou. Por isso
-- faltas_status/faltas_suprir quebram com:
--   column "suprida_por" of relation "faltas" does not exist

alter table public.faltas add column if not exists modulo        text;
alter table public.faltas add column if not exists codigo        text;
alter table public.faltas add column if not exists nome          text not null default '';
alter table public.faltas add column if not exists qtd           numeric not null default 0;
alter table public.faltas add column if not exists status        text not null default 'aberta';
alter table public.faltas add column if not exists almoxarifado  text not null default 'frente';
alter table public.faltas add column if not exists criado_em     timestamptz not null default now();
alter table public.faltas add column if not exists criado_por    text;
alter table public.faltas add column if not exists suprida_em    timestamptz;
alter table public.faltas add column if not exists suprida_por   text;
alter table public.faltas add column if not exists notificada_em timestamptz;
alter table public.faltas add column if not exists aparelho      text;

create index if not exists ix_faltas_criado   on public.faltas (modulo, criado_em desc);
create index if not exists ix_faltas_abertas  on public.faltas (modulo, suprida_em) where suprida_em is null;
create index if not exists ix_faltas_suprida  on public.faltas (modulo, suprida_em desc);
