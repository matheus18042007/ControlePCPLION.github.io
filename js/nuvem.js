/* =========================================================
   Nuvem - Supabase (PostgREST via fetch, sem SDK)
   A URL e a chave anon ficam no localStorage de cada aparelho,
   NAO no codigo publicado no GitHub.
   ========================================================= */
var Nuvem = (function () {
  'use strict';

  var cfg = { url: '', key: '' };
  var online = false;          // ultima chamada deu certo?
  var CHAVE_CFG = 'nuvem_cfg';

  function carregar() {
    try {
      var c = JSON.parse(localStorage.getItem(CHAVE_CFG) || '{}');
      cfg.url = (c.url || '').replace(/\/+$/, '');
      cfg.key = c.key || '';
    } catch (e) { cfg = { url: '', key: '' }; }
    return cfg;
  }

  function salvarCfg(url, key) {
    cfg.url = (url || '').trim().replace(/\/+$/, '');
    cfg.key = (key || '').trim();
    localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg));
  }

  function limpar() {
    cfg = { url: '', key: '' };
    online = false;
    localStorage.removeItem(CHAVE_CFG);
  }

  function ativa() { return !!(cfg.url && cfg.key); }
  function conectado() { return online; }
  function config() { return { url: cfg.url, key: cfg.key }; }

  /* identifica o aparelho no historico */
  function aparelho() {
    var id = localStorage.getItem('aparelho_id');
    if (!id) {
      id = 'AP-' + Math.random().toString(36).slice(2, 7).toUpperCase();
      localStorage.setItem('aparelho_id', id);
    }
    return id;
  }

  function req(caminho, opcoes) {
    if (!ativa()) return Promise.reject(new Error('Nuvem nao configurada'));
    var o = opcoes || {};
    var h = {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json'
    };
    if (o.headers) for (var k in o.headers) h[k] = o.headers[k];

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, o.timeout || 15000) : null;

    return fetch(cfg.url + '/rest/v1' + caminho, {
      method: o.method || 'GET',
      headers: h,
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store'
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r.text().then(function (txt) {
        var dados = null;
        if (txt) { try { dados = JSON.parse(txt); } catch (e) { dados = txt; } }
        if (!r.ok) {
          online = false;
          var msg = (dados && (dados.message || dados.hint || dados.error)) || ('HTTP ' + r.status);
          throw new Error(msg);
        }
        online = true;
        return dados;
      });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      if (e.name === 'AbortError') { online = false; throw new Error('Tempo esgotado (sem conexao)'); }
      if (e instanceof TypeError) { online = false; throw new Error('Sem conexao com a nuvem'); }
      throw e;
    });
  }

  /* ---------- leitura ---------- */
  function testar() {
    return req('/itens?select=codigo&limit=1').then(function () { return true; });
  }

  function puxarItens() {
    return req('/itens?select=*&order=codigo');
  }

  /* saldo oficial de um item só (rápido, usado ao abrir o item) */
  function puxarItem(codigo) {
    return req('/itens?select=*&codigo=eq.' + encodeURIComponent(codigo), { timeout: 8000 })
      .then(function (r) { return (r && r.length) ? r[0] : null; });
  }

  function puxarMovimentacoes(limite) {
    return req('/movimentacoes?select=*&order=id.desc&limit=' + (limite || 3000));
  }

  function puxarTudo(limiteMov) {
    return Promise.all([puxarItens(), puxarMovimentacoes(limiteMov)])
      .then(function (r) { return { itens: r[0] || [], movimentacoes: r[1] || [] }; });
  }

  /* ---------- escrita ---------- */
  function registrarMov(codigo, tipo, qtd, usuario, obs, permitirNegativo) {
    return req('/rpc/registrar_movimentacao', {
      method: 'POST',
      body: {
        p_codigo: codigo,
        p_tipo: tipo,
        p_qtd: qtd,
        p_usuario: usuario || null,
        p_obs: obs || null,
        p_permitir_negativo: !!permitirNegativo,
        p_aparelho: aparelho()
      }
    });
  }

  function cadastrarItem(item, usuario) {
    return req('/rpc/cadastrar_item', {
      method: 'POST',
      body: {
        p_codigo: item.codigo,
        p_nome: item.nome,
        p_descricao: item.descricao || null,
        p_unidade: item.unidade_medida || 'UN',
        p_saldo: Number(item.estoque_atual) || 0,
        p_minimo: Number(item.estoque_minimo) || 0,
        p_usuario: usuario || null
      }
    });
  }

  function editarItem(codigo, campos) {
    campos.atualizado_em = new Date().toISOString();
    return req('/itens?codigo=eq.' + encodeURIComponent(codigo), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: campos
    });
  }

  /* importacao em lote (CSV) - insere novos e atualiza existentes */
  function enviarItens(lista, atualizarExistentes) {
    if (!lista.length) return Promise.resolve([]);
    var lotes = [], i;
    for (i = 0; i < lista.length; i += 200) lotes.push(lista.slice(i, i + 200));

    var pref = atualizarExistentes
      ? 'resolution=merge-duplicates,return=minimal'
      : 'resolution=ignore-duplicates,return=minimal';

    return lotes.reduce(function (p, lote) {
      return p.then(function () {
        return req('/itens?on_conflict=codigo', {
          method: 'POST',
          headers: { Prefer: pref },
          body: lote,
          timeout: 30000
        });
      });
    }, Promise.resolve());
  }

  return {
    carregar: carregar,
    salvarCfg: salvarCfg,
    limpar: limpar,
    ativa: ativa,
    conectado: conectado,
    config: config,
    aparelho: aparelho,
    testar: testar,
    puxarTudo: puxarTudo,
    puxarItens: puxarItens,
    puxarItem: puxarItem,
    registrarMov: registrarMov,
    cadastrarItem: cadastrarItem,
    editarItem: editarItem,
    enviarItens: enviarItens
  };
})();
