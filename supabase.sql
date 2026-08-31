-- =========================================================
--  Almoxarifado PBA - estrutura do banco na nuvem (Supabase)
--  Cole TUDO isto no  SQL Editor  do Supabase e clique RUN.
--  Pode rodar de novo sem problema (nao apaga dados).
-- =========================================================

-- ---------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------
create table if not exists public.itens (
  codigo          text primary key,
  nome            text not null,
  descricao       text,
  unidade_medida  text not null default 'UN',
  estoque_atual   numeric not null default 0,
  estoque_minimo  numeric not null default 0,
  data_cadastro   timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);

create table if not exists public.movimentacoes (
  id           bigint generated always as identity primary key,
  codigo_item  text not null references public.itens(codigo) on update cascade,
  tipo         text not null check (tipo in ('ENTRADA', 'SAIDA')),
  quantidade   numeric not null check (quantidade > 0),
  data_hora    timestamptz not null default now(),
  usuario      text,
  observacao   text,
  saldo_apos   numeric,
  aparelho     text
);

create index if not exists ix_mov_item on public.movimentacoes (codigo_item);
create index if not exists ix_mov_data on public.movimentacoes (data_hora desc);

-- ---------------------------------------------------------
-- 2. Movimentacao ATOMICA (a parte mais importante)
--    Trava a linha do item (for update), soma/subtrai e grava
--    o historico numa unica transacao. Dois celulares dando
--    baixa no mesmo instante NAO se sobrescrevem.
-- ---------------------------------------------------------
create or replace function public.registrar_movimentacao(
  p_codigo            text,
  p_tipo              text,
  p_qtd               numeric,
  p_usuario           text default null,
  p_obs               text default null,
  p_permitir_negativo boolean default false,
  p_aparelho          text default null
)
returns public.itens
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item  public.itens;
  v_delta numeric;
begin
  if p_qtd is null or p_qtd <= 0 then
    raise exception 'Quantidade deve ser maior que zero';
  end if;
  if p_tipo not in ('ENTRADA', 'SAIDA') then
    raise exception 'Tipo invalido: %', p_tipo;
  end if;

  select * into v_item from public.itens where codigo = p_codigo for update;
  if not found then
    raise exception 'Item % nao cadastrado', p_codigo;
  end if;

  v_delta := case when p_tipo = 'ENTRADA' then p_qtd else -p_qtd end;

  if not p_permitir_negativo and (v_item.estoque_atual + v_delta) < 0 then
    raise exception 'Saldo insuficiente: disponivel %', v_item.estoque_atual;
  end if;

  update public.itens
     set estoque_atual = estoque_atual + v_delta,
         atualizado_em = now()
   where codigo = p_codigo
  returning * into v_item;

  insert into public.movimentacoes
    (codigo_item, tipo, quantidade, usuario, observacao, saldo_apos, aparelho)
  values
    (p_codigo, p_tipo, p_qtd, p_usuario, p_obs, v_item.estoque_atual, p_aparelho);

  return v_item;
end;
$$;

-- ---------------------------------------------------------
-- 3. Cadastro de item + estoque inicial (tambem atomico)
-- ---------------------------------------------------------
create or replace function public.cadastrar_item(
  p_codigo    text,
  p_nome      text,
  p_descricao text default null,
  p_unidade   text default 'UN',
  p_saldo     numeric default 0,
  p_minimo    numeric default 0,
  p_usuario   text default null
)
returns public.itens
language plpgsql
security definer
set search_path = public
as $$
declare v_item public.itens;
begin
  if exists (select 1 from public.itens where codigo = p_codigo) then
    raise exception 'Ja existe um item com o codigo %', p_codigo;
  end if;

  insert into public.itens (codigo, nome, descricao, unidade_medida, estoque_atual, estoque_minimo)
  values (p_codigo, p_nome, p_descricao, coalesce(p_unidade, 'UN'),
          coalesce(p_saldo, 0), coalesce(p_minimo, 0))
  returning * into v_item;

  if coalesce(p_saldo, 0) > 0 then
    insert into public.movimentacoes
      (codigo_item, tipo, quantidade, usuario, observacao, saldo_apos)
    values
      (p_codigo, 'ENTRADA', p_saldo, p_usuario, 'Estoque inicial (cadastro)', p_saldo);
  end if;

  return v_item;
end;
$$;

-- ---------------------------------------------------------
-- 4. Seguranca (RLS)
--    O app usa a chave "anon", que fica no celular. Liberamos
--    ler / inserir / atualizar, mas NAO apagar: o historico de
--    movimentacoes e' append-only e nao pode ser adulterado
--    pelo aparelho. Exclusoes so' pelo painel do Supabase.
-- ---------------------------------------------------------
alter table public.itens         enable row level security;
alter table public.movimentacoes enable row level security;

drop policy if exists itens_ler      on public.itens;
drop policy if exists itens_inserir  on public.itens;
drop policy if exists itens_editar   on public.itens;
drop policy if exists mov_ler        on public.movimentacoes;
drop policy if exists mov_inserir    on public.movimentacoes;

create policy itens_ler     on public.itens         for select to anon, authenticated using (true);
create policy itens_inserir on public.itens         for insert to anon, authenticated with check (true);
create policy itens_editar  on public.itens         for update to anon, authenticated using (true) with check (true);
create policy mov_ler       on public.movimentacoes for select to anon, authenticated using (true);
create policy mov_inserir   on public.movimentacoes for insert to anon, authenticated with check (true);

grant execute on function public.registrar_movimentacao(text, text, numeric, text, text, boolean, text) to anon, authenticated;
grant execute on function public.cadastrar_item(text, text, text, text, numeric, numeric, text) to anon, authenticated;

-- ---------------------------------------------------------
-- 5. Relatorio pronto (opcional) - itens abaixo do minimo
--    Use no painel: select * from public.v_estoque_baixo;
-- ---------------------------------------------------------
create or replace view public.v_estoque_baixo as
  select codigo, nome, estoque_atual, estoque_minimo, unidade_medida
    from public.itens
   where estoque_minimo > 0 and estoque_atual <= estoque_minimo
   order by estoque_atual;
