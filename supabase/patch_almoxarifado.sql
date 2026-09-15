-- Patch pontual: so o Almoxarifado PBA (registrar_movimentacao).
-- Nao toca em tabelas nem nos modulos de contagem. Pode rodar sozinho.
--
-- Correcao: movimentacoes_quantidade_check exige quantidade > 0, e
-- movimentacoes_tipo_check so aceita 'ENTRADA' / 'SAIDA'. A versao antiga
-- gravava a quantidade negativa na saida. Agora o sinal fica so no tipo,
-- igual ao que o app ja grava no SQLite local.

drop function if exists public.registrar_movimentacao(text,text,numeric,text,text,boolean,text);

create function public.registrar_movimentacao(
  p_codigo text, p_tipo text, p_qtd numeric,
  p_usuario text default null, p_obs text default null,
  p_permitir_negativo boolean default false, p_aparelho text default null
) returns public.itens
language plpgsql security definer set search_path = public as $$
declare v_delta numeric; v_saldo numeric; v_row public.itens;
begin
  v_delta := case when lower(p_tipo) = 'saida' then -abs(p_qtd) else abs(p_qtd) end;

  update public.itens
     set estoque_atual = case when lower(p_tipo) = 'ajuste' then p_qtd
                              else estoque_atual + v_delta end,
         atualizado_em = now()
   where codigo = p_codigo
  returning * into v_row;

  v_saldo := v_row.estoque_atual;

  if v_saldo is null then
    raise exception 'Item % nao existe', p_codigo;
  end if;

  if v_saldo < 0 and not coalesce(p_permitir_negativo, false) then
    raise exception 'Saldo insuficiente para % (ficaria %)', p_codigo, v_saldo;
  end if;

  insert into public.movimentacoes
    (codigo_item, tipo, quantidade, qtd_final, usuario, observacao, aparelho)
  values (p_codigo, upper(p_tipo), abs(p_qtd), v_saldo, p_usuario, p_obs, p_aparelho);

  -- o app (upsertLocal em js/app.js) espera a linha do ITEM de volta.
  return v_row;
end $$;

grant execute on function public.registrar_movimentacao(text,text,numeric,text,text,boolean,text) to anon, authenticated;
