-- =========================================================
--   Controle PCP LION - modulo EFICIENCIA VG na nuvem
--
--   Cole TUDO isto no  SQL Editor  do Supabase e clique RUN.
--   Pode rodar de novo sem problema (nao apaga dados).
--
--   Isto NAO mexe em nada do Almoxarifado PBA nem dos
--   modulos de contagem (Quadros VG / Carenagens VG).
--
--   Controle DIARIO de falta e hora extra da producao:
--     eficiencia_colaboradores -> a folha do dia EM ABERTO
--     eficiencia_dias          -> historico, 10 dias
--
--   Situacao guarda so o codigo:
--     'I' = dia todo | 'P' = parcial | '' = falta
--
--   A coluna "modulo" existe pelo mesmo motivo da contagem:
--   um segundo controle de eficiencia (outra fabrica, outro
--   turno) NAO exige rodar SQL novo - e so registrar no app.
-- =========================================================

-- ---------------------------------------------------------
--   1. Tabelas
-- ---------------------------------------------------------
create table if not exists public.eficiencia_colaboradores (
  modulo        text not null,
  id            text not null,
  setor         text not null,
  nome          text not null,
  situacao      text not null default '' check (situacao in ('I', 'P', '')),
  hora          numeric not null default 0 check (hora >= 0),
  data_cadastro timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  primary key (modulo, id)
);

create table if not exists public.eficiencia_dias (
  modulo         text not null,
  colaborador_id text not null,
  setor          text not null,
  nome           text not null,
  situacao       text not null default '' check (situacao in ('I', 'P', '')),
  hora           numeric not null default 0 check (hora >= 0),
  data           date not null,
  usuario        text,
  aparelho       text,
  criado_em      timestamptz not null default now(),
  primary key (modulo, colaborador_id, data)
);

create index if not exists ix_efic_colab_setor
  on public.eficiencia_colaboradores (modulo, setor, nome);
create index if not exists ix_efic_dias_data
  on public.eficiencia_dias (modulo, data desc);

-- ---------------------------------------------------------
--   2. Marcar situacao / hora de UM colaborador
--
--   Trava a linha (for update) antes de mexer, entao dois
--   celulares marcando ao mesmo tempo nao se atropelam.
-- ---------------------------------------------------------
create or replace function public.eficiencia_marcar(
  p_modulo   text,
  p_id       text,
  p_situacao text,
  p_hora     numeric default 0,
  p_usuario  text default null,
  p_aparelho text default null
)
returns public.eficiencia_colaboradores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_colab public.eficiencia_colaboradores;
  v_sit   text;
begin
  v_sit := coalesce(upper(btrim(p_situacao)), '');
  if v_sit not in ('I', 'P', '') then
    raise exception 'Situacao invalida: % (use I, P ou vazio)', p_situacao;
  end if;

  if coalesce(p_hora, 0) < 0 then
    raise exception 'Hora nao pode ser negativa';
  end if;

  select * into v_colab
    from public.eficiencia_colaboradores
   where modulo = p_modulo and id = p_id
     for update;

  if not found then
    raise exception 'Colaborador % nao existe no modulo %', p_id, p_modulo;
  end if;

  update public.eficiencia_colaboradores
     set situacao = v_sit,
         hora = coalesce(p_hora, 0),
         atualizado_em = now()
   where modulo = p_modulo and id = p_id
  returning * into v_colab;

  return v_colab;
end;
$$;

-- ---------------------------------------------------------
--   3. Cadastrar colaborador (ou so renomear, se ja existir)
-- ---------------------------------------------------------
create or replace function public.eficiencia_cadastrar(
  p_modulo   text,
  p_id       text,
  p_setor    text,
  p_nome     text,
  p_usuario  text default null,
  p_aparelho text default null
)
returns public.eficiencia_colaboradores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_colab public.eficiencia_colaboradores;
begin
  if p_setor is null or btrim(p_setor) = '' then
    raise exception 'Informe o setor';
  end if;
  if p_nome is null or btrim(p_nome) = '' then
    raise exception 'Informe o nome do colaborador';
  end if;

  select * into v_colab
    from public.eficiencia_colaboradores
   where modulo = p_modulo and id = p_id
     for update;

  if found then
    -- ja existe: so acerta setor/nome, a marcacao do dia nao e tocada
    update public.eficiencia_colaboradores
       set setor = p_setor, nome = p_nome, atualizado_em = now()
     where modulo = p_modulo and id = p_id
    returning * into v_colab;
    return v_colab;
  end if;

  insert into public.eficiencia_colaboradores (modulo, id, setor, nome)
  values (p_modulo, p_id, p_setor, p_nome)
  returning * into v_colab;

  return v_colab;
end;
$$;

-- ---------------------------------------------------------
--   4. FINALIZAR o dia
--
--   Numa transacao so:
--     a) arquiva a folha inteira em eficiencia_dias com a data;
--     b) limpa a folha (situacao = '', hora = 0) para amanha;
--     c) poda o historico, deixando so os ultimos 10 dias.
--
--   Refinalizar o mesmo dia SUBSTITUI o que ja estava la, em
--   vez de dar erro - as vezes se erra e precisa refazer.
-- ---------------------------------------------------------
create or replace function public.eficiencia_finalizar(
  p_modulo   text,
  p_data     date default null,
  p_usuario  text default null,
  p_aparelho text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_data date;
  v_n    integer;
begin
  v_data := coalesce(p_data, current_date);

  delete from public.eficiencia_dias
   where modulo = p_modulo and data = v_data;

  insert into public.eficiencia_dias
    (modulo, colaborador_id, setor, nome, situacao, hora, data, usuario, aparelho)
  select modulo, id, setor, nome, situacao, hora, v_data, p_usuario, p_aparelho
    from public.eficiencia_colaboradores
   where modulo = p_modulo;

  get diagnostics v_n = row_count;

  update public.eficiencia_colaboradores
     set situacao = '', hora = 0, atualizado_em = now()
   where modulo = p_modulo and (situacao <> '' or hora <> 0);

  -- retencao: 10 dias
  delete from public.eficiencia_dias
   where modulo = p_modulo and data < v_data - 10;

  return v_n;
end;
$$;

-- ---------------------------------------------------------
--   5. Excluir colaborador (leva o historico dele junto)
-- ---------------------------------------------------------
create or replace function public.eficiencia_excluir(
  p_modulo   text,
  p_id       text,
  p_usuario  text default null,
  p_aparelho text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dias integer := 0;
begin
  delete from public.eficiencia_dias
   where modulo = p_modulo and colaborador_id = p_id;
  get diagnostics v_dias = row_count;

  delete from public.eficiencia_colaboradores
   where modulo = p_modulo and id = p_id;

  return json_build_object('id', p_id, 'dias', v_dias);
end;
$$;

-- ---------------------------------------------------------
--   6. Views com o nome "de negocio" (so para consultar
--      comodamente no painel do Supabase / Excel)
-- ---------------------------------------------------------
create or replace view public.eficiencia_vg as
  select setor, nome as colaborador, situacao, hora, atualizado_em
    from public.eficiencia_colaboradores
   where modulo = 'eficiencia';

create or replace view public.eficiencia_vg_historico as
  select data, setor, nome as colaborador, situacao, hora, usuario, aparelho
    from public.eficiencia_dias
   where modulo = 'eficiencia';

-- ---------------------------------------------------------
--   7. Seguranca (RLS) - mesmo padrao do almoxarifado:
--      quem tem a chave anon (que so sai do cofre no login)
--      le e escreve; as regras de negocio ficam nas funcoes.
-- ---------------------------------------------------------
alter table public.eficiencia_colaboradores enable row level security;
alter table public.eficiencia_dias          enable row level security;

drop policy if exists efic_ler      on public.eficiencia_colaboradores;
drop policy if exists efic_inserir  on public.eficiencia_colaboradores;
drop policy if exists efic_editar   on public.eficiencia_colaboradores;
drop policy if exists edias_ler     on public.eficiencia_dias;
drop policy if exists edias_inserir on public.eficiencia_dias;

create policy efic_ler     on public.eficiencia_colaboradores for select to anon, authenticated using (true);
create policy efic_inserir on public.eficiencia_colaboradores for insert to anon, authenticated with check (true);
create policy efic_editar  on public.eficiencia_colaboradores for update to anon, authenticated using (true) with check (true);
create policy edias_ler    on public.eficiencia_dias          for select to anon, authenticated using (true);
create policy edias_inserir on public.eficiencia_dias         for insert to anon, authenticated with check (true);

grant execute on function public.eficiencia_marcar(text, text, text, numeric, text, text) to anon, authenticated;
grant execute on function public.eficiencia_cadastrar(text, text, text, text, text, text)  to anon, authenticated;
grant execute on function public.eficiencia_finalizar(text, date, text, text)              to anon, authenticated;
grant execute on function public.eficiencia_excluir(text, text, text, text)                to anon, authenticated;
