/* =========================================================
   Nuvem - Supabase (PostgREST via fetch, sem SDK)
   A URL e a chave anon vem SOMENTE do cofre cifrado
   (js/usuarios.js), aberto no login. Nada e guardado no
   aparelho e o operador nao configura nem desliga nada:
   todo mundo que entra usa o mesmo banco oficial.
   ========================================================= */
var Nuvem = (function () {
  'use strict';

  var cfg = { url: '', key: '' };
  var online = false;          // ultima chamada deu certo?

  /* Fonte unica: o cofre. (NUVEM_PADRAO em texto puro so
     sobrevive como legado, para instalacoes antigas.) */
  function padrao() {
    var p = null;
    if (typeof Auth !== 'undefined' && Auth.configNuvem) p = Auth.configNuvem();
    if (!p && typeof NUVEM_PADRAO !== 'undefined') p = NUVEM_PADRAO;
    if (!p) return null;
    var u = (p.url || '').trim().replace(/\/+$/, '');
    var k = (p.key || '').trim();
    return (u && k) ? { url: u, key: k } : null;
  }

  /* chamada a cada login/logout: a config vive so na memoria */
  function carregar() {
    var p = padrao();
    cfg = p ? { url: p.url, key: p.key } : { url: '', key: '' };
    if (!p) online = false;
    /* limpeza de versoes antigas, que copiavam a chave no aparelho */
    try {
      localStorage.removeItem('nuvem_cfg');
      localStorage.removeItem('nuvem_desligada');
    } catch (e) {}
    return cfg;
  }

  function ativa() { return !!(cfg.url && cfg.key); }
  function conectado() { return online; }
  function config() { return { url: cfg.url, key: cfg.key }; }

  /* so o host, para mostrar na tela sem expor a chave */
  function servidor() {
    if (!cfg.url) return '';
    try { return new URL(cfg.url).host; } catch (e) { return cfg.url; }
  }

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

  /* O Supabase corta toda resposta em 1000 linhas (db-max-rows), mesmo
     pedindo mais. Entao buscamos de pagina em pagina ate acabar.
     A ordenacao precisa ser estavel para o offset nao repetir/pular linha. */
  var PAGINA = 1000;

  function puxarPaginado(caminho, limiteTotal, aoProgredir) {
    var tudo = [];
    var teto = limiteTotal || Infinity;

    function proxima(offset) {
      var falta = teto - tudo.length;
      if (falta <= 0) return Promise.resolve(tudo);
      var tam = Math.min(PAGINA, falta);

      return req(caminho + '&limit=' + tam + '&offset=' + offset, { timeout: 30000 })
        .then(function (lote) {
          lote = lote || [];
          tudo = tudo.concat(lote);
          if (aoProgredir) aoProgredir(tudo.length);
          /* pagina incompleta = chegou ao fim */
          if (lote.length < tam) return tudo;
          return proxima(offset + lote.length);
        });
    }

    return proxima(0);
  }

  function puxarItens(aoProgredir) {
    return puxarPaginado('/itens?select=*&order=codigo', null, aoProgredir);
  }

  /* saldo oficial de um item só (rápido, usado ao abrir o item) */
  function puxarItem(codigo) {
    return req('/itens?select=*&codigo=eq.' + encodeURIComponent(codigo), { timeout: 8000 })
      .then(function (r) { return (r && r.length) ? r[0] : null; });
  }

  /* historico: so o mais recente vale a pena no celular (o resto fica na nuvem) */
  function puxarMovimentacoes(limite, aoProgredir) {
    return puxarPaginado('/movimentacoes?select=*&order=id.desc', limite || 5000, aoProgredir);
  }

  function puxarTudo(limiteMov, aoProgredir) {
    var nItens = 0, nMov = 0;
    var passo = aoProgredir ? function () { aoProgredir(nItens, nMov); } : null;

    return puxarItens(function (n) { nItens = n; if (passo) passo(); })
      .then(function (itens) {
        return puxarMovimentacoes(limiteMov, function (n) { nMov = n; if (passo) passo(); })
          .then(function (movs) {
            return { itens: itens || [], movimentacoes: movs || [] };
          });
      });
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

  /* apaga o item e todo o historico dele na nuvem (nao tem volta) */
  function excluirItem(codigo, usuario) {
    return req('/rpc/excluir_item', {
      method: 'POST',
      body: {
        p_codigo: codigo,
        p_usuario: usuario || null,
        p_aparelho: aparelho()
      },
      timeout: 30000
    }).then(function (r) { return (r && r.codigo) ? r : { codigo: codigo, movimentacoes: 0 }; });
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

  /* =======================================================
     MODULOS DE CONTAGEM (Quadros VG, Carenagens VG, ...)

     Na nuvem todos moram em contagem_itens / contagem_movimentacoes,
     separados pela coluna "modulo". Por isso um modulo novo NAO
     precisa de SQL novo: basta chamar Nuvem.contagem('id_novo').
     Ver supabase_contagem.sql.
  ======================================================= */
  function contagem(modulo) {
    var m = encodeURIComponent(modulo);

    function puxarItens(aoProgredir) {
      return puxarPaginado(
        '/contagem_itens?select=*&modulo=eq.' + m + '&order=codigo', null, aoProgredir);
    }

    function puxarMovs(limite, aoProgredir) {
      return puxarPaginado(
        '/contagem_movimentacoes?select=*&modulo=eq.' + m + '&order=id.desc',
        limite || 5000, aoProgredir);
    }

    function puxarTudo(limiteMov, aoProgredir) {
      var nItens = 0, nMov = 0;
      var passo = aoProgredir ? function () { aoProgredir(nItens, nMov); } : null;
      return puxarItens(function (n) { nItens = n; if (passo) passo(); })
        .then(function (itens) {
          return puxarMovs(limiteMov, function (n) { nMov = n; if (passo) passo(); })
            .then(function (movs) {
              return { itens: itens || [], movimentacoes: movs || [] };
            });
        });
    }

    /* absoluto = true  -> "a quantidade agora e esta"
       absoluto = false -> "some/subtraia isto" (botoes - e +) */
    function definir(codigo, qtd, absoluto, usuario, obs) {
      return req('/rpc/contagem_definir', {
        method: 'POST',
        body: {
          p_modulo: modulo,
          p_codigo: codigo,
          p_qtd: qtd,
          p_absoluto: !!absoluto,
          p_usuario: usuario || null,
          p_obs: obs || null,
          p_aparelho: aparelho()
        }
      });
    }

    function cadastrar(codigo, nome, qtd, usuario) {
      return req('/rpc/contagem_cadastrar', {
        method: 'POST',
        body: {
          p_modulo: modulo,
          p_codigo: codigo,
          p_nome: nome,
          p_qtd: Number(qtd) || 0,
          p_usuario: usuario || null,
          p_aparelho: aparelho()
        }
      });
    }

    function zerar(usuario, obs) {
      return req('/rpc/contagem_zerar', {
        method: 'POST',
        body: {
          p_modulo: modulo,
          p_usuario: usuario || null,
          p_obs: obs || null,
          p_aparelho: aparelho()
        },
        timeout: 30000
      });
    }

    function excluir(codigo, usuario) {
      return req('/rpc/contagem_excluir', {
        method: 'POST',
        body: {
          p_modulo: modulo,
          p_codigo: codigo,
          p_usuario: usuario || null,
          p_aparelho: aparelho()
        },
        timeout: 30000
      }).then(function (r) {
        return (r && r.codigo) ? r : { codigo: codigo, movimentacoes: 0 };
      });
    }

    /* importacao em lote (CSV) e envio dos itens deste aparelho */
    function enviarItens(lista, atualizarExistentes) {
      if (!lista.length) return Promise.resolve([]);
      var lotes = [], i;
      var comModulo = lista.map(function (it) {
        return { modulo: modulo, codigo: it.codigo, nome: it.nome, qtd: Number(it.qtd) || 0 };
      });
      for (i = 0; i < comModulo.length; i += 200) lotes.push(comModulo.slice(i, i + 200));

      var pref = atualizarExistentes
        ? 'resolution=merge-duplicates,return=minimal'
        : 'resolution=ignore-duplicates,return=minimal';

      return lotes.reduce(function (p, lote) {
        return p.then(function () {
          return req('/contagem_itens?on_conflict=modulo,codigo', {
            method: 'POST',
            headers: { Prefer: pref },
            body: lote,
            timeout: 30000
          });
        });
      }, Promise.resolve());
    }

    return {
      modulo: modulo,
      puxarItens: puxarItens,
      puxarMovs: puxarMovs,
      puxarTudo: puxarTudo,
      definir: definir,
      cadastrar: cadastrar,
      zerar: zerar,
      excluir: excluir,
      enviarItens: enviarItens
    };
  }

  /* =======================================================
     MODULO EFICIENCIA VG (controle diario de faltas / horas)

     Mesma ideia dos modulos de contagem: tudo mora em
     eficiencia_colaboradores / eficiencia_dias, separados pela
     coluna "modulo". Ver supabase_eficiencia.sql.
  ======================================================= */
  function eficiencia(modulo) {
    var m = encodeURIComponent(modulo);

    function puxarColaboradores(aoProgredir) {
      return puxarPaginado(
        '/eficiencia_colaboradores?select=*&modulo=eq.' + m + '&order=setor,nome',
        null, aoProgredir);
    }

    function puxarDias(aoProgredir) {
      return puxarPaginado(
        '/eficiencia_dias?select=*&modulo=eq.' + m + '&order=data.desc',
        5000, aoProgredir);
    }

    function puxarTudo(aoProgredir) {
      var nC = 0, nD = 0;
      var passo = aoProgredir ? function () { aoProgredir(nC, nD); } : null;
      return puxarColaboradores(function (n) { nC = n; if (passo) passo(); })
        .then(function (colaboradores) {
          return puxarDias(function (n) { nD = n; if (passo) passo(); })
            .then(function (dias) {
              return { colaboradores: colaboradores || [], dias: dias || [] };
            });
        });
    }

    /* marca a situacao (I / P / "") e as horas do colaborador
       na folha em aberto */
    function marcar(colaboradorId, situacao, hora, usuario) {
      return req('/rpc/eficiencia_marcar', {
        method: 'POST',
        body: {
          p_modulo: modulo,
          p_id: colaboradorId,
          p_situacao: situacao || '',
          p_hora: Number(hora) || 0,
          p_usuario: usuario || null,
          p_aparelho: aparelho()
        }
      });
    }

    function cadastrar(colaboradorId, setor, nome, usuario) {
      return req('/rpc/eficiencia_cadastrar', {
        method: 'POST',
        body: {
          p_modulo: modulo,
          p_id: colaboradorId,
          p_setor: setor,
          p_nome: nome,
          p_usuario: usuario || null,
          p_aparelho: aparelho()
        }
      });
    }

    /* arquiva o dia, limpa a folha e poda o historico -
       tudo numa transacao so, para todos os aparelhos */
    function finalizar(data, usuario) {
      return req('/rpc/eficiencia_finalizar', {
        method: 'POST',
        body: {
          p_modulo: modulo,
          p_data: data,
          p_usuario: usuario || null,
          p_aparelho: aparelho()
        },
        timeout: 30000
      });
    }

    function excluir(colaboradorId, usuario) {
      return req('/rpc/eficiencia_excluir', {
        method: 'POST',
        body: {
          p_modulo: modulo,
          p_id: colaboradorId,
          p_usuario: usuario || null,
          p_aparelho: aparelho()
        },
        timeout: 30000
      });
    }

    /* cadastro em lote (CSV / envio deste aparelho).
       Quem ja existe la NAO e sobrescrito: a folha do dia que
       esta na nuvem e a oficial. */
    function enviarColaboradores(lista) {
      if (!lista.length) return Promise.resolve([]);
      var lotes = [], i;
      var comModulo = lista.map(function (c) {
        return { modulo: modulo, id: c.id, setor: c.setor, nome: c.nome };
      });
      for (i = 0; i < comModulo.length; i += 200) lotes.push(comModulo.slice(i, i + 200));

      return lotes.reduce(function (p, lote) {
        return p.then(function () {
          return req('/eficiencia_colaboradores?on_conflict=modulo,id', {
            method: 'POST',
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: lote,
            timeout: 30000
          });
        });
      }, Promise.resolve());
    }

    return {
      puxarTudo: puxarTudo,
      puxarColaboradores: puxarColaboradores,
      puxarDias: puxarDias,
      marcar: marcar,
      cadastrar: cadastrar,
      finalizar: finalizar,
      excluir: excluir,
      enviarColaboradores: enviarColaboradores
    };
  }

  return {
    carregar: carregar,
    contagem: contagem,
    eficiencia: eficiencia,
    ativa: ativa,
    conectado: conectado,
    config: config,
    servidor: servidor,
    aparelho: aparelho,
    testar: testar,
    puxarTudo: puxarTudo,
    puxarItens: puxarItens,
    puxarItem: puxarItem,
    registrarMov: registrarMov,
    cadastrarItem: cadastrarItem,
    excluirItem: excluirItem,
    editarItem: editarItem,
    enviarItens: enviarItens
  };
})();
