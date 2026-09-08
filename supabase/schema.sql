-- ============================================================================
--  Controle PCP LION - schema completo do Supabase
--
--  Rode ESTE arquivo inteiro no SQL Editor de um projeto novo e o app
--  funciona: tabelas, indices, RLS, permissoes e todas as funcoes (RPC)
--  que o js/nuvem.js chama.
--
--  Reconstruido a partir do codigo do app (js/nuvem.js + a Edge Function
--  faltas-notificar). E o contrato que o app espera; se o banco atual tiver
--  alguma coluna a mais, ela nao aparece aqui.
--
--  Depois de rodar:
--    1. Edge Function:  supabase functions deploy faltas-notificar
--    2. Secrets:        supabase secrets set VAPID_PUBLIC=... VAPID_PRIVATE=...
--                       VAPID_SUBJECT=mailto:voce@empresa.com
--    3. No app: modulo Banco de Dados > Nuvem > endereco + chave anon.
--
--  Idempotente: pode rodar de novo sem quebrar nada.
-- ============================================================================

-- ============================================================================
--  1. ALMOXARIFADO PBA  (modulo 'almox' - tabelas sem coluna "modulo")
-- ============================================================================

create table if not exists public.itens (
  codigo          text primary key,
  nome            text not null,
  descricao       text,
  unidade_medida  text not null default 'UN',
  estoque_atual   numeric not null default 0,
  estoque_minimo  numeric not null default 0,
  data_cadastro   timestamptz not null default now(),
  atualizado_em   timestamptz
);

create table if not exists public.movimentacoes (
  id           bigint generated always as identity primary key,
  codigo_item  text not null references public.itens(codigo) on delete cascade,
  tipo         text not null,               -- 'entrada' | 'saida' | 'ajuste'
  quantidade   numeric not null,
  qtd_final    numeric,                     -- saldo depois do lancamento
  data_hora    timestamptz not null default now(),
  usuario      text,
  observacao   text,
  aparelho     text
);

create index if not exists ix_mov_item on public.movimentacoes (codigo_item);
create index if not exists ix_mov_data on public.movimentacoes (data_hora desc);

-- ============================================================================
--  2. MODULOS DE CONTAGEM  (Quadros VG, Carenagens CG, ...)
--     Todos moram nas mesmas tabelas, separados pela coluna "modulo".
-- ============================================================================

create table if not exists public.contagem_itens (
  modulo         text not null,
  codigo         text not null,
  nome           text not null default '',
  qtd            numeric not null default 0,
  ordem          integer not null default 0,
  atualizado_em  timestamptz not null default now(),
  primary key (modulo, codigo)
);

create table if not exists public.contagem_movimentacoes (
  id         bigint generated always as identity primary key,
  modulo     text not null,
  codigo     text not null,
  nome       text,
  qtd        numeric not null default 0,
  qtd_final  numeric,
  tipo       text,                          -- 'definir' | 'somar' | 'zerar' | 'cadastrar' | 'excluir'
  data_hora  timestamptz not null default now(),
  usuario    text,
  obs        text,
  aparelho   text
);

create index if not exists ix_cont_mov on public.contagem_movimentacoes (modulo, id desc);

-- foto de referencia do item (data URL em texto). Tabela propria: a
-- sincronizacao de contagem_itens apaga e regrava os itens.
create table if not exists public.contagem_fotos (
  modulo         text not null,
  codigo         text not null,
  foto           text,                      -- data:image/...;base64,....
  usuario        text,
  atualizado_em  timestamptz not null default now(),
  primary key (modulo, codigo)
);

-- ============================================================================
--  3. EFICIENCIA VG  (faltas de pessoal / horas por setor)
-- ============================================================================

create table if not exists public.eficiencia_colaboradores (
  modulo         text not null,
  id             text not null,
  setor          text not null default '',
  nome           text not null,
  situacao       text not null default '',  -- 'I' | 'P' | ''
  hora           numeric not null default 0,
  ordem          integer not null default 0,
  atualizado_em  timestamptz not null default now(),
  primary key (modulo, id)
);

create index if not exists ix_efic_setor on public.eficiencia_colaboradores (modulo, setor);

-- historico: uma linha por colaborador por dia fechado
create table if not exists public.eficiencia_dias (
  modulo         text not null,
  colaborador_id text not null,
  data           date not null,
  setor          text not null default '',
  nome           text not null default '',
  situacao       text not null default '',
  hora           numeric not null default 0,
  ordem          integer not null default 0,
  usuario        text,
  aparelho       text,
  primary key (modulo, colaborador_id, data)
);

create index if not exists ix_efic_dias_data on public.eficiencia_dias (modulo, data desc);

-- ============================================================================
--  4. FALTAS VG  (registro de faltas de pecas + push)
-- ============================================================================

-- catalogo: codigo -> nome vigente (importado por CSV)
create table if not exists public.faltas_componentes (
  modulo  text not null,
  codigo  text not null,
  nome    text not null default '',
  ordem   integer not null default 0,
  primary key (modulo, codigo)
);

create table if not exists public.faltas (
  modulo        text not null,
  id            text not null,
  codigo        text not null,
  nome          text not null default '',
  qtd           numeric not null default 0,
  status        text not null default 'aberta',
  almoxarifado  text not null default 'frente',   -- 'frente' | 'fundo'
  criado_em     timestamptz not null default now(),
  criado_por    text,
  suprida_em    timestamptz,
  suprida_por   text,
  notificada_em timestamptz,
  aparelho      text,
  primary key (modulo, id)
);

create index if not exists ix_faltas_criado   on public.faltas (modulo, criado_em desc);
create index if not exists ix_faltas_abertas  on public.faltas (modulo, suprida_em) where suprida_em is null;
create index if not exists ix_faltas_suprida  on public.faltas (modulo, suprida_em desc);

-- cooldown do disparo de notificacao (1 linha por modulo)
create table if not exists public.faltas_notif_estado (
  modulo        text primary key,
  ultimo_envio  timestamptz
);

-- aparelhos inscritos no push (a Edge Function le esta tabela)
create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  p256dh      text not null,
  auth        text not null,
  usuario     text,
  aparelho    text,
  criado_em   timestamptz not null default now()
);

-- ============================================================================
--  5. RLS - o app usa a chave anon; leitura direta, escrita so via RPC
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'itens','movimentacoes','contagem_itens','contagem_movimentacoes',
    'contagem_fotos','eficiencia_colaboradores','eficiencia_dias',
    'faltas','faltas_componentes','faltas_notif_estado','push_subscriptions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists anon_leitura on public.%I', t);
    execute format('create policy anon_leitura on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

-- upserts/edicoes que o app faz direto pelo PostgREST (sem RPC):
--   itens PATCH, contagem_itens, contagem_fotos, eficiencia_colaboradores,
--   faltas_componentes
do $$
declare t text;
begin
  foreach t in array array[
    'itens','contagem_itens','contagem_fotos',
    'eficiencia_colaboradores','faltas_componentes'
  ] loop
    execute format('drop policy if exists anon_escrita on public.%I', t);
    execute format('create policy anon_escrita on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on
  public.itens, public.contagem_itens, public.contagem_fotos,
  public.eficiencia_colaboradores, public.faltas_componentes
  to anon, authenticated;

-- ============================================================================
--  6. FUNCOES (RPC) - todas SECURITY DEFINER: escrevem passando por cima do RLS
-- ============================================================================

-- ---------- almoxarifado ----------

create or replace function public.registrar_movimentacao(
  p_codigo text, p_tipo text, p_qtd numeric,
  p_usuario text default null, p_obs text default null,
  p_permitir_negativo boolean default false, p_aparelho text default null
) returns public.movimentacoes
language plpgsql security definer set search_path = public as $$
declare v_delta numeric; v_saldo numeric; v_row public.movimentacoes;
begin
  v_delta := case when lower(p_tipo) = 'saida' then -abs(p_qtd) else abs(p_qtd) end;

  update public.itens
     set estoque_atual = case when lower(p_tipo) = 'ajuste' then p_qtd
                              else estoque_atual + v_delta end,
         atualizado_em = now()
   where codigo = p_codigo
  returning estoque_atual into v_saldo;

  if v_saldo is null then
    raise exception 'Item % nao existe', p_codigo;
  end if;

  if v_saldo < 0 and not coalesce(p_permitir_negativo, false) then
    raise exception 'Saldo insuficiente para % (ficaria %)', p_codigo, v_saldo;
  end if;

  insert into public.movimentacoes
    (codigo_item, tipo, quantidade, qtd_final, usuario, observacao, aparelho)
  values (p_codigo, p_tipo, v_delta, v_saldo, p_usuario, p_obs, p_aparelho)
  returning * into v_row;

  return v_row;
end $$;

create or replace function public.cadastrar_item(
  p_codigo text, p_nome text, p_descricao text default null,
  p_unidade text default 'UN', p_saldo numeric default 0,
  p_minimo numeric default 0, p_usuario text default null
) returns public.itens
language plpgsql security definer set search_path = public as $$
declare v_row public.itens;
begin
  insert into public.itens
    (codigo, nome, descricao, unidade_medida, estoque_atual, estoque_minimo)
  values (p_codigo, p_nome, p_descricao, coalesce(p_unidade,'UN'),
          coalesce(p_saldo,0), coalesce(p_minimo,0))
  on conflict (codigo) do update
     set nome = excluded.nome,
         descricao = excluded.descricao,
         unidade_medida = excluded.unidade_medida,
         estoque_minimo = excluded.estoque_minimo,
         atualizado_em = now()
  returning * into v_row;

  if coalesce(p_saldo,0) <> 0 then
    insert into public.movimentacoes
      (codigo_item, tipo, quantidade, qtd_final, usuario, observacao)
    values (p_codigo, 'entrada', p_saldo, v_row.estoque_atual, p_usuario, 'cadastro');
  end if;

  return v_row;
end $$;

create or replace function public.excluir_item(
  p_codigo text, p_usuario text default null, p_aparelho text default null
) returns table (codigo text, movimentacoes bigint)
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  delete from public.movimentacoes where codigo_item = p_codigo;
  get diagnostics n = row_count;
  delete from public.itens where itens.codigo = p_codigo;
  return query select p_codigo, n;
end $$;

-- ---------- contagem ----------

create or replace function public.contagem_definir(
  p_modulo text, p_codigo text, p_qtd numeric, p_absoluto boolean default true,
  p_usuario text default null, p_obs text default null, p_aparelho text default null
) returns public.contagem_itens
language plpgsql security definer set search_path = public as $$
declare v_row public.contagem_itens;
begin
  update public.contagem_itens
     set qtd = case when coalesce(p_absoluto,true) then p_qtd else qtd + p_qtd end,
         atualizado_em = now()
   where modulo = p_modulo and codigo = p_codigo
  returning * into v_row;

  if v_row is null then
    raise exception 'Item % nao existe no modulo %', p_codigo, p_modulo;
  end if;

  insert into public.contagem_movimentacoes
    (modulo, codigo, nome, qtd, qtd_final, tipo, usuario, obs, aparelho)
  values (p_modulo, p_codigo, v_row.nome, p_qtd, v_row.qtd,
          case when coalesce(p_absoluto,true) then 'definir' else 'somar' end,
          p_usuario, p_obs, p_aparelho);

  return v_row;
end $$;

create or replace function public.contagem_cadastrar(
  p_modulo text, p_codigo text, p_nome text, p_qtd numeric default 0,
  p_usuario text default null, p_aparelho text default null
) returns public.contagem_itens
language plpgsql security definer set search_path = public as $$
declare v_row public.contagem_itens;
begin
  insert into public.contagem_itens (modulo, codigo, nome, qtd)
  values (p_modulo, p_codigo, p_nome, coalesce(p_qtd,0))
  on conflict (modulo, codigo) do update
     set nome = excluded.nome, atualizado_em = now()
  returning * into v_row;

  insert into public.contagem_movimentacoes
    (modulo, codigo, nome, qtd, qtd_final, tipo, usuario, aparelho)
  values (p_modulo, p_codigo, p_nome, coalesce(p_qtd,0), v_row.qtd,
          'cadastrar', p_usuario, p_aparelho);

  return v_row;
end $$;

create or replace function public.contagem_zerar(
  p_modulo text, p_usuario text default null,
  p_obs text default null, p_aparelho text default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into public.contagem_movimentacoes
    (modulo, codigo, nome, qtd, qtd_final, tipo, usuario, obs, aparelho)
  select modulo, codigo, nome, qtd, 0, 'zerar', p_usuario, p_obs, p_aparelho
    from public.contagem_itens where modulo = p_modulo and qtd <> 0;
  get diagnostics n = row_count;

  update public.contagem_itens
     set qtd = 0, atualizado_em = now()
   where modulo = p_modulo and qtd <> 0;

  return n;
end $$;

create or replace function public.contagem_excluir(
  p_modulo text, p_codigo text,
  p_usuario text default null, p_aparelho text default null
) returns table (codigo text, movimentacoes bigint)
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  delete from public.contagem_movimentacoes
   where modulo = p_modulo and contagem_movimentacoes.codigo = p_codigo;
  get diagnostics n = row_count;

  delete from public.contagem_itens
   where modulo = p_modulo and contagem_itens.codigo = p_codigo;
  delete from public.contagem_fotos
   where modulo = p_modulo and contagem_fotos.codigo = p_codigo;

  return query select p_codigo, n;
end $$;

-- ---------- eficiencia ----------

create or replace function public.eficiencia_marcar(
  p_modulo text, p_id text, p_situacao text default '',
  p_hora numeric default 0, p_usuario text default null, p_aparelho text default null
) returns public.eficiencia_colaboradores
language plpgsql security definer set search_path = public as $$
declare v_row public.eficiencia_colaboradores;
begin
  update public.eficiencia_colaboradores
     set situacao = coalesce(p_situacao,''),
         hora = coalesce(p_hora,0),
         atualizado_em = now()
   where modulo = p_modulo and id = p_id
  returning * into v_row;

  if v_row is null then
    raise exception 'Colaborador % nao existe no modulo %', p_id, p_modulo;
  end if;
  return v_row;
end $$;

create or replace function public.eficiencia_cadastrar(
  p_modulo text, p_id text, p_setor text, p_nome text,
  p_ordem integer default 0, p_usuario text default null, p_aparelho text default null
) returns public.eficiencia_colaboradores
language plpgsql security definer set search_path = public as $$
declare v_row public.eficiencia_colaboradores;
begin
  insert into public.eficiencia_colaboradores (modulo, id, setor, nome, ordem)
  values (p_modulo, p_id, coalesce(p_setor,''), p_nome, coalesce(p_ordem,0))
  on conflict (modulo, id) do update
     set setor = excluded.setor, nome = excluded.nome,
         ordem = excluded.ordem, atualizado_em = now()
  returning * into v_row;
  return v_row;
end $$;

-- fecha o dia: arquiva a folha em eficiencia_dias e limpa a folha aberta
create or replace function public.eficiencia_finalizar(
  p_modulo text, p_data date, p_usuario text default null, p_aparelho text default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into public.eficiencia_dias
    (modulo, colaborador_id, data, setor, nome, situacao, hora, ordem, usuario, aparelho)
  select modulo, id, p_data, setor, nome, situacao, hora, ordem, p_usuario, p_aparelho
    from public.eficiencia_colaboradores
   where modulo = p_modulo
  on conflict (modulo, colaborador_id, data) do update
     set setor = excluded.setor, nome = excluded.nome,
         situacao = excluded.situacao, hora = excluded.hora,
         ordem = excluded.ordem, usuario = excluded.usuario;
  get diagnostics n = row_count;

  update public.eficiencia_colaboradores
     set situacao = '', hora = 0, atualizado_em = now()
   where modulo = p_modulo;

  return n;
end $$;

create or replace function public.eficiencia_excluir(
  p_modulo text, p_id text, p_usuario text default null, p_aparelho text default null
) returns text
language plpgsql security definer set search_path = public as $$
begin
  delete from public.eficiencia_colaboradores
   where modulo = p_modulo and id = p_id;
  return p_id;
end $$;

-- ---------- faltas ----------

create or replace function public.faltas_registrar(
  p_modulo text, p_id text, p_codigo text, p_nome text default '',
  p_qtd numeric default 0, p_usuario text default null,
  p_aparelho text default null, p_almoxarifado text default 'frente'
) returns public.faltas
language plpgsql security definer set search_path = public as $$
declare v_row public.faltas;
begin
  insert into public.faltas
    (modulo, id, codigo, nome, qtd, criado_por, aparelho, almoxarifado)
  values (p_modulo, p_id, p_codigo, coalesce(p_nome,''), coalesce(p_qtd,0),
          p_usuario, p_aparelho, coalesce(p_almoxarifado,'frente'))
  on conflict (modulo, id) do update
     set qtd = excluded.qtd, nome = excluded.nome,
         almoxarifado = excluded.almoxarifado
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.faltas_status(
  p_modulo text, p_id text, p_status text, p_usuario text default null
) returns public.faltas
language plpgsql security definer set search_path = public as $$
declare v_row public.faltas;
begin
  update public.faltas
     set status = coalesce(p_status,'aberta'),
         suprida_em  = case when p_status = 'suprida' then now() else null end,
         suprida_por = case when p_status = 'suprida' then p_usuario else null end
   where modulo = p_modulo and id = p_id
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.faltas_suprir(
  p_modulo text, p_id text, p_usuario text default null
) returns public.faltas
language sql security definer set search_path = public as $$
  select public.faltas_status(p_modulo, p_id, 'suprida', p_usuario);
$$;

create or replace function public.faltas_reabrir(
  p_modulo text, p_id text, p_usuario text default null
) returns public.faltas
language sql security definer set search_path = public as $$
  select public.faltas_status(p_modulo, p_id, 'aberta', p_usuario);
$$;

create or replace function public.faltas_excluir(
  p_modulo text, p_id text, p_usuario text default null
) returns text
language plpgsql security definer set search_path = public as $$
begin
  delete from public.faltas where modulo = p_modulo and id = p_id;
  return p_id;
end $$;

-- ---------- push ----------

create or replace function public.push_registrar(
  p_endpoint text, p_p256dh text, p_auth text,
  p_usuario text default null, p_aparelho text default null
) returns public.push_subscriptions
language plpgsql security definer set search_path = public as $$
declare v_row public.push_subscriptions;
begin
  insert into public.push_subscriptions (endpoint, p256dh, auth, usuario, aparelho)
  values (p_endpoint, p_p256dh, p_auth, p_usuario, p_aparelho)
  on conflict (endpoint) do update
     set p256dh = excluded.p256dh, auth = excluded.auth,
         usuario = excluded.usuario, aparelho = excluded.aparelho
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.push_remover(p_endpoint text)
returns text
language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_subscriptions where endpoint = p_endpoint;
  return p_endpoint;
end $$;

-- ============================================================================
--  7. Permissao de execucao das RPCs para a chave anon
-- ============================================================================

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as assinatura
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'registrar_movimentacao','cadastrar_item','excluir_item',
         'contagem_definir','contagem_cadastrar','contagem_zerar','contagem_excluir',
         'eficiencia_marcar','eficiencia_cadastrar','eficiencia_finalizar','eficiencia_excluir',
         'faltas_registrar','faltas_status','faltas_suprir','faltas_reabrir','faltas_excluir',
         'push_registrar','push_remover')
  loop
    execute format('grant execute on function %s to anon, authenticated', f.assinatura);
  end loop;
end $$;

-- estado inicial do cooldown de notificacao
insert into public.faltas_notif_estado (modulo)
values ('faltas') on conflict (modulo) do nothing;
