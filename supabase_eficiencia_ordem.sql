-- =========================================================
--  Controle PCP LION - EFICIENCIA VG - coluna "ordem"
-- =========================================================
--  Cole TUDO isto no  SQL Editor  do Supabase e clique RUN.
--
--  Pode rodar de novo sem problema (nao apaga dados).
--  Isto NAO mexe em nada do Almoxarifado PBA nem dos modulos
--  de contagem (Quadros VG / Carenagens VG).
--
--  O que faz: guarda a ORDEM em que cada colaborador aparece
--  na planilha que voce importa, para a lista do app sair na
--  mesma sequencia (setores e pessoas), em vez de alfabetica.
-- =========================================================

-- ---------------------------------------------------------
--  1. Coluna nova nas duas tabelas
-- ---------------------------------------------------------
alter table public.eficiencia_colaboradores
  add column if not exists ordem integer not null default 0;

alter table public.eficiencia_dias
  add column if not exists ordem integer not null default 0;

create index if not exists ix_efic_colab_ordem
  on public.eficiencia_colaboradores (modulo, ordem);

-- ---------------------------------------------------------
--  2. Cadastrar colaborador (agora com a ordem)
--     p_ordem = 0  -> entra no fim da fila
--
--     A versao antiga (6 argumentos) precisa sair primeiro,
--     senao o Postgres fica com as duas e nao sabe qual chamar.
-- ---------------------------------------------------------
drop function if exists public.eficiencia_cadastrar(text, text, text, text, text, text);

create or replace function public.eficiencia_cadastrar(
  p_modulo   text,
  p_id       text,
  p_setor    text,
  p_nome     text,
  p_usuario  text default null,
  p_aparelho text default null,
  p_ordem    integer default 0
)
returns public.eficiencia_colaboradores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_colab public.eficiencia_colaboradores;
  v_ordem integer;
begin
  if p_setor is null or btrim(p_setor) = '' then
    raise exception 'Informe o setor';
  end if;
  if p_nome is null or btrim(p_nome) = '' then
    raise exception 'Informe o nome do colaborador';
  end if;

  v_ordem := coalesce(nullif(p_ordem, 0), 0);
  if v_ordem = 0 then
    select coalesce(max(ordem), 0) + 1 into v_ordem
      from public.eficiencia_colaboradores
     where modulo = p_modulo;
  end if;

  select * into v_colab
    from public.eficiencia_colaboradores
   where modulo = p_modulo and id = p_id
     for update;

  if found then
    -- ja existe: so acerta setor/nome/ordem, a marcacao do dia nao e tocada
    update public.eficiencia_colaboradores
       set setor = p_setor, nome = p_nome, ordem = v_ordem, atualizado_em = now()
     where modulo = p_modulo and id = p_id
     returning * into v_colab;
    return v_colab;
  end if;

  insert into public.eficiencia_colaboradores (modulo, id, setor, nome, ordem)
       values (p_modulo, p_id, p_setor, p_nome, v_ordem)
    returning * into v_colab;

  return v_colab;
end;
$$;

-- ---------------------------------------------------------
--  3. Finalizar o dia levando a ordem para o historico
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
        (modulo, colaborador_id, setor, nome, situacao, hora, data, usuario, aparelho, ordem)
  select modulo, id, setor, nome, situacao, hora, v_data, p_usuario, p_aparelho, ordem
    from public.eficiencia_colaboradores
   where modulo = p_modulo;

  get diagnostics v_n = row_count;

  update public.eficiencia_colaboradores
     set situacao = '', hora = 0, atualizado_em = now()
   where modulo = p_modulo and (situacao <> '' or hora > 0);

  -- retencao: 10 dias
  delete from public.eficiencia_dias
   where modulo = p_modulo and data < v_data - 10;

  return v_n;
end;
$$;

-- ---------------------------------------------------------
--  4. Views com a ordem junto
-- ---------------------------------------------------------
drop view if exists public.eficiencia_vg cascade;
create view public.eficiencia_vg as
  select setor, nome as colaborador, situacao, hora, ordem, atualizado_em
    from public.eficiencia_colaboradores
   where modulo = 'eficiencia'
   order by ordem, setor, nome;

drop view if exists public.eficiencia_vg_historico cascade;
create view public.eficiencia_vg_historico as
  select data, setor, nome as colaborador, situacao, hora, usuario, aparelho
    from public.eficiencia_dias
   where modulo = 'eficiencia'
   order by data desc, ordem, setor, nome;

-- ---------------------------------------------------------
--  5. Permissao da funcao com a assinatura nova
-- ---------------------------------------------------------
grant execute on function public.eficiencia_cadastrar(text, text, text, text, text, text, integer)
  to anon, authenticated;
grant execute on function public.eficiencia_finalizar(text, date, text, text)
  to anon, authenticated;

notify pgrst, 'reload schema';
