-- =========================================================
--  Controle PCP LION - modulos de CONTAGEM na nuvem
--  (Contagem de Quadros VG, Carenagens VG, e os proximos)
--
--  Cole TUDO isto no  SQL Editor  do Supabase e clique RUN.
--  Pode rodar de novo sem problema (nao apaga dados).
--  Isto NAO mexe em nada do Almoxarifado PBA.
--
--  POR QUE UMA TABELA SO COM A COLUNA "modulo"?
--  No celular cada modulo tem o seu proprio arquivo SQLite
--  (bancos separados de verdade). Na nuvem eles moram nas
--  mesmas duas tabelas, separados pela coluna "modulo".
--  Vantagem: criar o 4o, o 5o modulo NAO exige rodar SQL
--  nenhum de novo - e so registrar o modulo no app.
--  Para consultar no Supabase com os nomes de sempre, na
--  secao 6 estao as views quadros, movimentacoes_quadros,
--  carenagens e movimentacoes_carenagens.
-- =========================================================

-- ---------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------
create table if not exists public.contagem_itens (
  modulo         text not null,
  codigo         text not null,
  nome           text not null,
  qtd            numeric not null default 0,
  data_cadastro  timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  primary key (modulo, codigo)
);

create table if not exists public.contagem_movimentacoes (
  id           bigint generated always as identity primary key,
  modulo       text not null,
  codigo_item  text not null,
  tipo         text not null check (tipo in ('ENTRADA', 'SAIDA', 'ZERAGEM')),
  quantidade   numeric not null check (quantidade >= 0),
  qtd_final    numeric,
  data_hora    timestamptz not null default now(),
  usuario      text,
  observacao   text,
  aparelho     text
);

create index if not exists ix_cmov_modulo on public.contagem_movimentacoes (modulo, id desc);
create index if not exists ix_cmov_item   on public.contagem_movimentacoes (modulo, codigo_item);

-- ---------------------------------------------------------
-- 2. Alterar a quantidade de UM item (atomico)
--    Trava a linha (for update) antes de mexer, entao dois
--    celulares contando o mesmo item nao se sobrescrevem.
--    p_absoluto = true  -> "a quantidade agora e p_qtd"
--    p_absoluto = false -> "some p_qtd no que ja tem" (+/-)
-- ---------------------------------------------------------
create or replace function public.contagem_definir(
  p_modulo    text,
  p_codigo    text,
  p_qtd       numeric,
  p_absoluto  boolean default true,
  p_usuario   text default null,
  p_obs       text default null,
  p_aparelho  text default null
)
returns public.contagem_itens
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item  public.contagem_itens;
  v_nova  numeric;
  v_delta numeric;
begin
  if p_modulo is null or p_codigo is null then
    raise exception 'Modulo e codigo sao obrigatorios';
  end if;
  if p_qtd is null then
    raise exception 'Quantidade invalida';
  end if;

  select * into v_item
    from public.contagem_itens
   where modulo = p_modulo and codigo = p_codigo
   for update;

  if not found then
    raise exception 'Item % nao existe no modulo %', p_codigo, p_modulo;
  end if;

  if p_absoluto then
    v_nova := p_qtd;
  else
    v_nova := v_item.qtd + p_qtd;
  end if;

  if v_nova < 0 then
    raise exception 'A quantidade nao pode ficar negativa (% ficaria %)', p_codigo, v_nova;
  end if;

  v_delta := v_nova - v_item.qtd;

  -- nada mudou: devolve o item como esta, sem sujar o historico
  if v_delta = 0 then
    return v_item;
  end if;

  update public.contagem_itens
     set qtd = v_nova, atualizado_em = now()
   where modulo = p_modulo and codigo = p_codigo
  returning * into v_item;

  insert into public.contagem_movimentacoes
    (modulo, codigo_item, tipo, quantidade, qtd_final, usuario, observacao, aparelho)
  values
    (p_modulo, p_codigo,
     case when v_delta > 0 then 'ENTRADA' else 'SAIDA' end,
     abs(v_delta), v_nova, p_usuario, p_obs, p_aparelho);

  return v_item;
end;
$$;

-- ---------------------------------------------------------
-- 3. Cadastrar item (ou so renomear, se ja existir)
-- ---------------------------------------------------------
create or replace function public.contagem_cadastrar(
  p_modulo   text,
  p_codigo   text,
  p_nome     text,
  p_qtd      numeric default 0,
  p_usuario  text default null,
  p_aparelho text default null
)
returns public.contagem_itens
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.contagem_itens;
begin
  if p_codigo is null or btrim(p_codigo) = '' then
    raise exception 'Informe o codigo do item';
  end if;
  if p_nome is null or btrim(p_nome) = '' then
    raise exception 'Informe o nome do item';
  end if;

  select * into v_item
    from public.contagem_itens
   where modulo = p_modulo and codigo = p_codigo
   for update;

  if found then
    -- item ja existe: so atualiza o nome, a contagem nao e tocada
    update public.contagem_itens
       set nome = p_nome, atualizado_em = now()
     where modulo = p_modulo and codigo = p_codigo
    returning * into v_item;
    return v_item;
  end if;

  insert into public.contagem_itens (modulo, codigo, nome, qtd)
  values (p_modulo, p_codigo, p_nome, coalesce(p_qtd, 0))
  returning * into v_item;

  if coalesce(p_qtd, 0) <> 0 then
    insert into public.contagem_movimentacoes
      (modulo, codigo_item, tipo, quantidade, qtd_final, usuario, observacao, aparelho)
    values
      (p_modulo, p_codigo, 'ENTRADA', abs(p_qtd), p_qtd, p_usuario, 'cadastro do item', p_aparelho);
  end if;

  return v_item;
end;
$$;

-- ---------------------------------------------------------
-- 4. ZERAR o modulo inteiro (a contagem e ciclica)
--    Grava uma movimentacao ZERAGEM por item antes de zerar,
--    tudo numa transacao so. Devolve quantos itens zerou.
-- ---------------------------------------------------------
create or replace function public.contagem_zerar(
  p_modulo   text,
  p_usuario  text default null,
  p_obs      text default null,
  p_aparelho text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  insert into public.contagem_movimentacoes
    (modulo, codigo_item, tipo, quantidade, qtd_final, usuario, observacao, aparelho)
  select modulo, codigo, 'ZERAGEM', qtd, 0, p_usuario,
         coalesce(p_obs, 'zeragem geral (contagem ciclica)'), p_aparelho
    from public.contagem_itens
   where modulo = p_modulo and qtd <> 0;

  get diagnostics v_n = row_count;

  update public.contagem_itens
     set qtd = 0, atualizado_em = now()
   where modulo = p_modulo and qtd <> 0;

  return v_n;
end;
$$;

-- ---------------------------------------------------------
-- 5. Excluir item (leva o historico dele junto)
-- ---------------------------------------------------------
create or replace function public.contagem_excluir(
  p_modulo   text,
  p_codigo   text,
  p_usuario  text default null,
  p_aparelho text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movs integer;
begin
  delete from public.contagem_movimentacoes
   where modulo = p_modulo and codigo_item = p_codigo;
  get diagnostics v_movs = row_count;

  delete from public.contagem_itens
   where modulo = p_modulo and codigo = p_codigo;

  return json_build_object('codigo', p_codigo, 'movimentacoes', v_movs);
end;
$$;

-- ---------------------------------------------------------
-- 6. Views com os nomes "de negocio" (so para consultar
--    comodamente no painel do Supabase / Excel)
-- ---------------------------------------------------------
create or replace view public.quadros as
  select codigo, nome, qtd, data_cadastro, atualizado_em
    from public.contagem_itens where modulo = 'quadro';

create or replace view public.movimentacoes_quadros as
  select id, codigo_item, tipo, quantidade, qtd_final, data_hora, usuario, observacao, aparelho
    from public.contagem_movimentacoes where modulo = 'quadro';

create or replace view public.carenagens as
  select codigo, nome, qtd, data_cadastro, atualizado_em
    from public.contagem_itens where modulo = 'carenagem';

create or replace view public.movimentacoes_carenagens as
  select id, codigo_item, tipo, quantidade, qtd_final, data_hora, usuario, observacao, aparelho
    from public.contagem_movimentacoes where modulo = 'carenagem';

-- ---------------------------------------------------------
-- 7. Seguranca (RLS) - mesmo padrao do almoxarifado:
--    quem tem a chave anon (que so sai do cofre no login)
--    le e escreve; as regras de negocio ficam nas funcoes.
-- ---------------------------------------------------------
alter table public.contagem_itens         enable row level security;
alter table public.contagem_movimentacoes enable row level security;

drop policy if exists citens_ler     on public.contagem_itens;
drop policy if exists citens_inserir on public.contagem_itens;
drop policy if exists citens_editar  on public.contagem_itens;
drop policy if exists cmov_ler       on public.contagem_movimentacoes;
drop policy if exists cmov_inserir   on public.contagem_movimentacoes;

create policy citens_ler     on public.contagem_itens         for select to anon, authenticated using (true);
create policy citens_inserir on public.contagem_itens         for insert to anon, authenticated with check (true);
create policy citens_editar  on public.contagem_itens         for update to anon, authenticated using (true) with check (true);
create policy cmov_ler       on public.contagem_movimentacoes for select to anon, authenticated using (true);
create policy cmov_inserir   on public.contagem_movimentacoes for insert to anon, authenticated with check (true);

grant execute on function public.contagem_definir(text, text, numeric, boolean, text, text, text) to anon, authenticated;
grant execute on function public.contagem_cadastrar(text, text, text, numeric, text, text)        to anon, authenticated;
grant execute on function public.contagem_zerar(text, text, text, text)                           to anon, authenticated;
grant execute on function public.contagem_excluir(text, text, text, text)                         to anon, authenticated;
