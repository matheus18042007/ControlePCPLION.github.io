/* =========================================================
   Controle PCP LION - MÓDULO FALTAS VG

   Registro de faltas de peças no chão de fábrica.

   Diferente dos outros módulos, este tem uma BASE DE
   COMPONENTES própria (código -> nome vigente, importada por
   CSV) que serve só para preencher o nome na hora de registrar.

   E é o único com NOTIFICAÇÃO: toda falta registrada entra numa
   fila; quem envia de verdade é a Edge Function
   (supabase/functions/faltas-notificar), que respeita um
   cooldown de 1 minuto para não explodir o celular de ninguém.
   Ver supabase_faltas.sql.
   ========================================================= */
window.ModuloFaltas = (function () {
  'use strict';

  /* status possíveis - a ordem aqui é a ordem do menu */
  var STATUS = [
    { cod: 'aberta',         label: 'Sem previsão',    cls: 'aberta' },
    { cod: 'produzindo',     label: 'Produzindo',      cls: 'produzindo' },
    { cod: 'transferencia',  label: 'Em transferência', cls: 'transferencia' },
    { cod: 'sera_produzido', label: 'Será produzido',  cls: 'sera' }
  ];

  function labelStatus(cod) {
    for (var i = 0; i < STATUS.length; i++) if (STATUS[i].cod === cod) return STATUS[i].label;
    return 'Sem previsão';
  }
  function clsStatus(cod) {
    for (var i = 0; i < STATUS.length; i++) if (STATUS[i].cod === cod) return STATUS[i].cls;
    return 'aberta';
  }
  function normStatus(v) {
    var s = String(v || '').trim().toLowerCase();
    for (var i = 0; i < STATUS.length; i++) if (STATUS[i].cod === s) return s;
    return 'aberta';
  }

  /* ---------------------------------------------------------
     Camada de banco (IndexedDB + SQLite)

     Repetida de propósito, como em js/eficiencia.js: cada módulo
     abre o SEU banco e um não derruba o outro ao mudar schema.
  --------------------------------------------------------- */
  function idbOpen(nome) {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(nome, 1);
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv');
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbSet(nome, key, val) {
    return idbOpen(nome).then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function () { d.close(); res(true); };
        tx.onerror = function () { d.close(); rej(tx.error); };
      });
    });
  }
  function idbGet(nome, key) {
    return idbOpen(nome).then(function (d) {
      return new Promise(function (res, rej) {
        var rq = d.transaction('kv', 'readonly').objectStore('kv').get(key);
        rq.onsuccess = function () { d.close(); res(rq.result); };
        rq.onerror = function () { d.close(); rej(rq.error); };
      });
    });
  }

  /* ---------- utilitários ---------- */
  function semAcento(s) {
    s = String(s == null ? '' : s);
    return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
  }

  /* id do registro: precisa ser único entre aparelhos offline */
  function novoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'F' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    var s = String(v).replace(/\s/g, '');
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  /* CSV simples (separador ; ou ,) - mesmo leitor do eficiencia */
  function lerCsv(texto) {
    var t = texto.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var linhas = t.split('\n').filter(function (l) { return l.trim() !== ''; });
    if (!linhas.length) return { cabecalho: [], linhas: [] };
    var sep = (linhas[0].split(';').length >= linhas[0].split(',').length) ? ';' : ',';
    var parse = function (linha) {
      var out = [], cur = '', aspas = false;
      for (var i = 0; i < linha.length; i++) {
        var c = linha[i];
        if (aspas) {
          if (c === '"' && linha[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') aspas = false;
          else cur += c;
        } else if (c === '"') aspas = true;
        else if (c === sep) { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out.map(function (x) { return x.trim(); });
    };
    var cab = parse(linhas[0]).map(function (h) { return semAcento(h).toLowerCase(); });
    return { cabecalho: cab, linhas: linhas.slice(1).map(parse) };
  }

  /* =========================================================
     A instância do módulo
     ========================================================= */
  function criarInstancia(cfg) {
    var P = window.PCP;
    var $ = P.$, qsa = P.qsa, esc = P.esc, toast = P.toast;

    var id = cfg.id;                    // 'faltas'
    var IDB = 'pcp_' + id;

    var db = null, saveTimer = null, montado = false, promessa = null;
    var estado = { busca: '', apiNuvem: null };

    var SCHEMA = [
      'CREATE TABLE IF NOT EXISTS componentes (',
      '  codigo TEXT PRIMARY KEY,',
      '  nome   TEXT NOT NULL,',
      '  ordem  INTEGER NOT NULL DEFAULT 0',
      ');',
      'CREATE TABLE IF NOT EXISTS faltas (',
      '  id         TEXT PRIMARY KEY,',
      '  codigo     TEXT NOT NULL,',
      '  nome       TEXT NOT NULL DEFAULT "",',
      '  qtd        REAL NOT NULL DEFAULT 0,',
      '  status     TEXT NOT NULL DEFAULT "aberta",',
      '  criado_em  DATETIME,',
      '  criado_por TEXT',
      ');',
      'CREATE INDEX IF NOT EXISTS ix_faltas_criado ON faltas (criado_em DESC);',
      'CREATE INDEX IF NOT EXISTS ix_comp_nome ON componentes (nome);'
    ].join('\n');

    function abrirBanco() {
      return initSqlJs({ locateFile: function (f) { return './vendor/' + f; } })
        .then(function (SQL) {
          return idbGet(IDB, 'dbfile').then(function (bytes) {
            if (bytes) {
              try { db = new SQL.Database(new Uint8Array(bytes)); }
              catch (e) { db = new SQL.Database(); }
            } else {
              db = new SQL.Database();
            }
            db.run(SCHEMA);
          });
        });
    }

    function salvar(imediato) {
      if (!db) return;
      clearTimeout(saveTimer);
      var grava = function () {
        idbSet(IDB, 'dbfile', db.export()).then(function () {
          try { localStorage.setItem('ultimo_salvamento_' + id, P.agoraISO()); } catch (e) {}
        });
      };
      if (imediato) grava(); else saveTimer = setTimeout(grava, 400);
    }

    function sel(sql, params) {
      var r = [], st = db.prepare(sql);
      if (params) st.bind(params);
      while (st.step()) r.push(st.getAsObject());
      st.free();
      return r;
    }
    function um(sql, params) { var r = sel(sql, params); return r[0] || null; }
    function escalar(sql, params) {
      var r = um(sql, params);
      return r ? r[Object.keys(r)[0]] : 0;
    }

    /* =======================================================
       HTML do módulo
    ======================================================= */
    function montarUI() {
      if (montado) return;
      montado = true;
      var main = $('main');

      var wrap = document.createElement('div');
      wrap.innerHTML = [
        /* ---------- ABA 1: FALTAS EM ABERTO ---------- */
        '<section id="view-' + id + '-lista" class="view" data-modulo="' + id + '">',
        '  <div class="falta-topo">',
        '    <button id="' + id + 'Nova" class="btn primary block" type="button">&#9888; Registrar falta</button>',
        '    <button id="' + id + 'Notificar" class="btn ghost block" type="button">&#128276; Notificar faltas</button>',
        '  </div>',
        '  <div class="searchbar">',
        '    <input id="' + id + 'Busca" type="search" inputmode="search" placeholder="Buscar código ou nome..." autocomplete="off">',
        '    <button id="' + id + 'LimpaBusca" class="icon-btn" type="button" aria-label="Limpar">&times;</button>',
        '  </div>',
        '  <div class="filters">',
        '    <span class="muted small">Em falta: <b id="' + id + 'Resumo">0</b></span>',
        '    <button id="' + id + 'Sync2" class="pill" type="button">&#8635; Atualizar</button>',
        '  </div>',
        '  <div id="' + id + 'Lista" class="list"></div>',
        '</section>',

        /* ---------- ABA 2: CONFIGURAÇÕES ---------- */
        '<section id="view-' + id + '-cfg" class="view" data-modulo="' + id + '">',
        '  <div class="card">',
        '    <h3>Notificações</h3>',
        '    <p class="muted small">Avisa todos os aparelhos quando alguém registra uma falta.',
        '       No máximo uma notificação a cada 1 minuto.</p>',
        '    <div class="kv"><span>Neste aparelho</span><b id="' + id + 'PushEstado">-</b></div>',
        '    <button id="' + id + 'PushAtivar" class="btn primary block" type="button">&#128276; Ativar notificações</button>',
        '    <button id="' + id + 'PushDesativar" class="btn ghost block" type="button">Desativar neste aparelho</button>',
        '    <p class="muted small warn" id="' + id + 'PushAviso"></p>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Base de componentes</h3>',
        '    <p class="muted small">CSV com as colunas <b>codigo</b> e <b>nome</b> (separador ; ou ,).',
        '       Reimportar atualiza os nomes de quem já existe.</p>',
        '    <input id="' + id + 'FileCsv" type="file" accept=".csv,.txt" hidden>',
        '    <button id="' + id + 'EscolherCsv" class="btn primary block" type="button">Escolher arquivo CSV</button>',
        '    <div id="' + id + 'CsvResultado" class="muted small"></div>',
        '    <div class="kv"><span>Componentes cadastrados</span><b id="' + id + 'StatComp">0</b></div>',
        '    <button id="' + id + 'Enviar" class="btn ghost block" type="button">&#8593; Enviar componentes deste aparelho</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Nuvem (Supabase)</h3>',
        '    <div class="kv"><span>Estado</span><b id="' + id + 'NuvemEstado">-</b></div>',
        '    <div class="kv"><span>Servidor</span><b id="' + id + 'NuvemServidor">-</b></div>',
        '    <div class="kv"><span>Aparelho</span><b id="' + id + 'NuvemAparelho">-</b></div>',
        '    <button id="' + id + 'Sync" class="btn primary block" type="button">&#8635; Sincronizar agora</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Dados</h3>',
        '    <div class="kv"><span>Faltas em aberto</span><b id="' + id + 'StatFaltas">0</b></div>',
        '    <div class="kv"><span>Último salvamento</span><b id="' + id + 'StatSalvo">-</b></div>',
        '    <button id="' + id + 'ExportCsv" class="btn ghost block" type="button">&#11015; Exportar faltas (.csv)</button>',
        '    <button id="' + id + 'Apagar" class="btn danger block" type="button">&#128465; Limpar cópia local deste módulo</button>',
        '  </div>',
        '</section>'
      ].join('\n');
      while (wrap.firstChild) main.appendChild(wrap.firstChild);

      /* ---------- tabbar própria ---------- */
      var nav = document.createElement('nav');
      nav.className = 'tabbar hidden';
      nav.id = 'tabbar-' + id;
      nav.setAttribute('data-modulo', id);
      nav.innerHTML = [
        '<button class="tab active" data-view="' + id + '-lista" type="button"><span>&#9888;</span>Faltas</button>',
        '<button class="tab" data-view="' + id + '-cfg" type="button"><span>&#9881;</span>Configurações</button>'
      ].join('');
      document.body.appendChild(nav);

      /* ---------- sheet de registro ---------- */
      var sheets = document.createElement('div');
      sheets.innerHTML = [
        '<div id="' + id + 'SheetNova" class="sheet-wrap" data-modulo="' + id + '">',
        '  <div class="sheet">',
        '    <div class="sheet-handle"></div>',
        '    <h3>Registrar falta</h3>',
        '    <label class="lbl">Código do componente *</label>',
        '    <input id="' + id + 'Codigo" type="text" inputmode="text" autocomplete="off" list="' + id + 'Componentes">',
        '    <datalist id="' + id + 'Componentes"></datalist>',
        '    <label class="lbl">Nome</label>',
        '    <input id="' + id + 'Nome" type="text" autocomplete="off" placeholder="preenche sozinho pelo código">',
        '    <label class="lbl">Quantidade faltante</label>',
        '    <input id="' + id + 'Qtd" type="number" inputmode="decimal" min="0" step="1" value="1">',
        '    <div class="sheet-actions">',
        '      <button class="btn ghost" data-' + id + '-fechar="1" type="button">Cancelar</button>',
        '      <button id="' + id + 'Add" class="btn primary" type="button">Adicionar falta</button>',
        '    </div>',
        '  </div>',
        '</div>'
      ].join('\n');
      while (sheets.firstChild) document.body.appendChild(sheets.firstChild);

      ligarEventos();
    }

    function fecharSheets() {
      $(id + 'SheetNova').classList.remove('open');
    }

    /* =======================================================
       NUVEM
    ======================================================= */
    function nv() {
      if (!(window.Nuvem && Nuvem.ativa())) return null;
      if (!estado.apiNuvem) estado.apiNuvem = Nuvem.faltas(id);
      return estado.apiNuvem;
    }
    function semNuvem() {
      toast('Sem nuvem: gravado só neste aparelho', 'err');
    }
    function statusNuvem() {
      if (!montado) return;
      var n = window.Nuvem;
      var txt = 'Não configurado (faça login no cofre)';
      if (n && n.ativa()) txt = n.conectado() ? 'Conectado' : 'Sem conexão com a nuvem';
      $(id + 'NuvemEstado').textContent = txt;
      $(id + 'NuvemServidor').textContent = (n && n.ativa()) ? n.servidor() : '-';
      $(id + 'NuvemAparelho').textContent = (n && n.aparelho()) ? n.aparelho() : '-';
      P.atualizarStatusNuvem();
    }

    /* substitui o cache local pelo que veio da nuvem */
    function gravarCache(dados) {
      db.run('BEGIN');
      try {
        db.run('DELETE FROM componentes;');
        db.run('DELETE FROM faltas;');
        (dados.componentes || []).forEach(function (c) {
          db.run('INSERT INTO componentes (codigo,nome,ordem) VALUES (?,?,?)',
            [c.codigo, c.nome, Number(c.ordem) || 0]);
        });
        (dados.faltas || []).forEach(function (f) {
          db.run('INSERT INTO faltas (id,codigo,nome,qtd,status,criado_em,criado_por) VALUES (?,?,?,?,?,?,?)',
            [f.id, f.codigo, f.nome || '', Number(f.qtd) || 0, normStatus(f.status),
             P.paraLocal(f.criado_em), f.criado_por || null]);
        });
        db.run('COMMIT');
      } catch (e) {
        try { db.run('ROLLBACK'); } catch (e2) {}
        throw e;
      }
      salvar(true);
    }

    function sincronizar(silencioso) {
      var api = nv();
      if (!api) { statusNuvem(); return Promise.resolve(false); }
      P.nuvemStatus('Sincronizando...', 'sync');
      return api.puxarTudo(function (nC, nF) {
        P.nuvemStatus('Baixando... ' + nC + ' comp.' + (nF ? ' / ' + nF + ' faltas' : ''), 'sync');
      }).then(function (d) {
        /* trava: nuvem sem componentes NUNCA apaga a base local.
           Nesse caso o certo é usar "Enviar componentes". */
        if (!d.componentes.length && escalar('SELECT COUNT(*) FROM componentes') > 0) {
          statusNuvem();
          if (!silencioso) toast('A nuvem está sem componentes. Envie a base deste aparelho primeiro.', 'err');
          return false;
        }
        gravarCache(d);
        statusNuvem();
        render();
        if (!silencioso) toast('Sincronizado · ' + d.faltas.length + ' faltas em aberto', 'ok');
        /* aproveita a passagem para destravar notificação pendente
           que ficou presa no cooldown (ver supabase_faltas.sql) */
        if (window.Nuvem && Nuvem.push) Nuvem.push.notificar(id);
        return true;
      }).catch(function (e) {
        statusNuvem();
        if (!silencioso) toast('Falha ao sincronizar: ' + e.message, 'err');
        return false;
      });
    }

    function enviarComponentesDaqui() {
      var api = nv();
      if (!api) { toast('Nuvem indisponível: faça login no cofre', 'err'); return; }
      var lista = sel('SELECT codigo,nome,ordem FROM componentes ORDER BY ordem,codigo');
      if (!lista.length) { toast('Nenhum componente para enviar', 'err'); return; }
      if (!confirm('Enviar ' + lista.length + ' componentes deste aparelho para a nuvem?\n\n' +
                   'Os nomes de quem já existir lá serão atualizados.')) return;
      P.nuvemStatus('Enviando...', 'sync');
      api.enviarComponentes(lista).then(function () {
        toast('Componentes enviados', 'ok');
        sincronizar(true);
      }).catch(function (e) {
        toast('Falha ao enviar: ' + e.message, 'err');
        statusNuvem();
      });
    }

    /* =======================================================
       AÇÕES
    ======================================================= */
    function nomeDoCodigo(codigo) {
      var c = um('SELECT nome FROM componentes WHERE codigo = ?', [String(codigo || '').trim()]);
      return c ? c.nome : '';
    }

    function abrirNova() {
      $(id + 'Codigo').value = '';
      $(id + 'Nome').value = '';
      $(id + 'Qtd').value = '1';
      $(id + 'SheetNova').classList.add('open');
      setTimeout(function () { $(id + 'Codigo').focus(); }, 120);
    }

    /* enquanto digita o código, mostra o nome vigente e sugere */
    function aoDigitarCodigo() {
      var v = String($(id + 'Codigo').value || '').trim();
      $(id + 'Nome').value = v ? nomeDoCodigo(v) : '';

      var dl = $(id + 'Componentes');
      if (!v || v.length < 2) { dl.innerHTML = ''; return; }
      var like = '%' + v.toUpperCase() + '%';
      var achados = sel(
        'SELECT codigo,nome FROM componentes WHERE UPPER(codigo) LIKE ? OR UPPER(nome) LIKE ? ORDER BY codigo LIMIT 20',
        [like, like]);
      dl.innerHTML = achados.map(function (c) {
        return '<option value="' + esc(c.codigo) + '">' + esc(c.nome) + '</option>';
      }).join('');
    }

    function adicionarFalta() {
      var codigo = String($(id + 'Codigo').value || '').trim();
      if (!codigo) { toast('Digite o código do componente', 'err'); return; }

      var nome = String($(id + 'Nome').value || '').trim() || nomeDoCodigo(codigo);
      if (!nome && !confirm('Código "' + codigo + '" não está na base de componentes.\n\nRegistrar assim mesmo?')) return;

      var qtd = num($(id + 'Qtd').value);
      var registro = {
        id: novoId(),
        codigo: codigo,
        nome: nome,
        qtd: qtd,
        status: 'aberta',
        criado_em: P.agoraISO(),
        criado_por: P.operador() || null
      };

      db.run('INSERT INTO faltas (id,codigo,nome,qtd,status,criado_em,criado_por) VALUES (?,?,?,?,?,?,?)',
        [registro.id, registro.codigo, registro.nome, registro.qtd,
         registro.status, registro.criado_em, registro.criado_por]);
      salvar();
      fecharSheets();
      render();
      toast('Falta registrada', 'ok');

      var api = nv();
      if (!api) { semNuvem(); return; }
      api.registrar(registro, P.operador()).then(function () {
        statusNuvem();
        /* bate na porta da Edge Function: ela decide se já
           passou 1 min do cooldown. Nunca derruba nada. */
        Nuvem.push.notificar(id);
      }).catch(function (e) {
        statusNuvem();
        toast('Gravado aqui, mas falhou na nuvem: ' + e.message, 'err');
      });
    }

    function mudarStatus(faltaId, novo) {
      novo = normStatus(novo);
      db.run('UPDATE faltas SET status = ? WHERE id = ?', [novo, faltaId]);
      salvar();
      renderLista();

      var api = nv();
      if (!api) { semNuvem(); return; }
      api.status(faltaId, novo, P.operador())
        .then(statusNuvem)
        .catch(function (e) { statusNuvem(); toast('Falhou na nuvem: ' + e.message, 'err'); });
    }

    function suprir(faltaId) {
      db.run('DELETE FROM faltas WHERE id = ?', [faltaId]);
      salvar();
      render();
      toast('Falta suprida', 'ok');

      var api = nv();
      if (!api) { semNuvem(); return; }
      api.suprir(faltaId, P.operador())
        .then(statusNuvem)
        .catch(function (e) { statusNuvem(); toast('Falhou na nuvem: ' + e.message, 'err'); });
    }

    /* =======================================================
       RENDER
    ======================================================= */
    function faltasVisiveis() {
      var q = semAcento(estado.busca).toLowerCase();
      var lista = sel('SELECT * FROM faltas ORDER BY criado_em DESC');
      if (!q) return lista;
      return lista.filter(function (f) {
        return semAcento(f.codigo + ' ' + f.nome).toLowerCase().indexOf(q) >= 0;
      });
    }

    function renderLista() {
      var el = $(id + 'Lista');
      if (!el) return;
      var lista = faltasVisiveis();

      if (!lista.length) {
        el.innerHTML = '<div class="vazio">' +
          (estado.busca ? 'Nada encontrado.' : 'Nenhuma falta registrada.<br>Toque em "Registrar falta".') +
          '</div>';
        return;
      }

      el.innerHTML = lista.map(function (f) {
        var opcoes = STATUS.map(function (s) {
          return '<option value="' + esc(s.cod) + '"' +
            (f.status === s.cod ? ' selected' : '') + '>' + esc(s.label) + '</option>';
        }).join('');

        return '<div class="li falta-li ' + clsStatus(f.status) + '" data-' + id + '-linha="' + esc(f.id) + '">' +
          '  <div class="falta-row">' +
          '    <div class="li-main">' +
          '      <div class="li-code">' + esc(f.codigo) + '</div>' +
          '      <div class="li-nome">' + esc(f.nome || '(sem nome na base)') + '</div>' +
          '      <div class="li-sub">Falta ' + P.fmtNum(f.qtd) + ' · ' +
                   esc(f.criado_por || '-') + ' · ' + esc(P.fmtDataHora(f.criado_em)) + '</div>' +
          '    </div>' +
          '    <select class="falta-sit" data-' + id + '-status="' + esc(f.id) + '"' +
          '      aria-label="Situação de ' + esc(f.codigo) + '">' + opcoes + '</select>' +
          '  </div>' +
          '  <label class="falta-sup">' +
          '    <input type="checkbox" data-' + id + '-suprir="' + esc(f.id) + '">' +
          '    <span>Suprida</span>' +
          '  </label>' +
          '</div>';
      }).join('');
    }

    function renderResumo() {
      var el = $(id + 'Resumo');
      if (el) el.textContent = escalar('SELECT COUNT(*) FROM faltas');
    }

    function renderStats() {
      $(id + 'StatComp').textContent = escalar('SELECT COUNT(*) FROM componentes');
      $(id + 'StatFaltas').textContent = escalar('SELECT COUNT(*) FROM faltas');
      $(id + 'StatSalvo').textContent =
        P.fmtDataHora(localStorage.getItem('ultimo_salvamento_' + id) || '') || '-';
      renderPush();
    }

    function renderPush() {
      var el = $(id + 'PushEstado'), aviso = $(id + 'PushAviso');
      if (!el) return;
      if (!window.Push || !Push.suportado()) {
        el.textContent = 'Não suportado neste navegador';
        aviso.textContent = 'No iPhone/iPad é preciso instalar o app na tela de início (Compartilhar › Adicionar à Tela de Início) para receber notificações.';
        return;
      }
      aviso.textContent = '';
      Push.estado().then(function (e) { el.textContent = e; });
    }

    function render() {
      renderLista();
      renderResumo();
      if ($(id + 'StatComp')) renderStats();
    }

    /* =======================================================
       IMPORTAÇÃO / EXPORTAÇÃO
    ======================================================= */
    function importarCsv(texto) {
      var res = $(id + 'CsvResultado');
      var d = lerCsv(texto);
      var iCod = d.cabecalho.indexOf('codigo');
      var iNome = d.cabecalho.indexOf('nome');
      if (iCod < 0 || iNome < 0) {
        res.innerHTML = '&#9888; CSV sem as colunas "codigo" e "nome".';
        return;
      }

      var novos = 0, atualizados = 0, ordem = 0;
      db.run('BEGIN');
      try {
        d.linhas.forEach(function (l) {
          var codigo = String(l[iCod] || '').trim();
          var nome = String(l[iNome] || '').trim();
          if (!codigo || !nome) return;
          ordem++;
          var existe = um('SELECT codigo FROM componentes WHERE codigo = ?', [codigo]);
          if (existe) {
            db.run('UPDATE componentes SET nome = ?, ordem = ? WHERE codigo = ?', [nome, ordem, codigo]);
            atualizados++;
          } else {
            db.run('INSERT INTO componentes (codigo,nome,ordem) VALUES (?,?,?)', [codigo, nome, ordem]);
            novos++;
          }
        });
        db.run('COMMIT');
      } catch (e) {
        try { db.run('ROLLBACK'); } catch (e2) {}
        res.innerHTML = '&#9888; Falha ao importar: ' + esc(e.message);
        return;
      }
      salvar(true);
      renderStats();
      res.innerHTML = '&#10003; <b>' + novos + '</b> novos · <b>' + atualizados + '</b> atualizados. Enviando para a nuvem...';

      var api = nv();
      if (!api) { res.innerHTML += '<br>&#9888; Importado só neste aparelho - a nuvem recusou: sem login.'; return; }
      var lista = sel('SELECT codigo,nome,ordem FROM componentes ORDER BY ordem,codigo');
      api.enviarComponentes(lista).then(function () {
        res.innerHTML = '&#10003; <b>' + novos + '</b> novos · <b>' + atualizados + '</b> atualizados · enviados para a nuvem.';
      }).catch(function (e) {
        res.innerHTML += '<br>&#9888; Importado aqui, mas falhou o envio: ' + esc(e.message);
      });
    }

    function exportarCsv() {
      var lista = sel('SELECT codigo,nome,qtd,status,criado_em,criado_por FROM faltas ORDER BY criado_em DESC');
      if (!lista.length) { toast('Nenhuma falta para exportar', 'err'); return; }
      var linhas = lista.map(function (f) {
        return { codigo: f.codigo, nome: f.nome, qtd: f.qtd,
                 situacao: labelStatus(f.status), registrado_em: f.criado_em,
                 registrado_por: f.criado_por || '' };
      });
      var txt = P.csvDe(['codigo', 'nome', 'qtd', 'situacao', 'registrado_em', 'registrado_por'], linhas);
      P.baixar(new Blob([txt], { type: 'text/csv;charset=utf-8' }),
               id + '_' + P.carimbo() + '.csv');
      toast('CSV gerado (pasta Downloads)', 'ok');
    }

    function apagarLocal() {
      if (!confirm('Apagar a cópia local deste módulo?\n\nA nuvem NÃO é afetada - basta sincronizar de novo.')) return;
      db.run('DELETE FROM faltas; DELETE FROM componentes;');
      salvar(true);
      toast('Cópia local apagada', 'ok');
      render();
    }

    /* =======================================================
       EVENTOS
    ======================================================= */
    function ligarEventos() {
      /* abas próprias: o ligarEventos() do app.js já rodou antes destas existirem */
      qsa('#tabbar-' + id + ' .tab').forEach(function (t) {
        t.addEventListener('click', function () { P.mostrarView(t.dataset.view); });
      });

      /* busca */
      var tBusca = null;
      $(id + 'Busca').addEventListener('input', function () {
        clearTimeout(tBusca);
        tBusca = setTimeout(function () {
          estado.busca = ($(id + 'Busca').value || '').trim().toLowerCase();
          renderLista();
        }, 180);
      });
      $(id + 'LimpaBusca').addEventListener('click', function () {
        $(id + 'Busca').value = '';
        estado.busca = '';
        renderLista();
      });

      /* registro */
      $(id + 'Nova').addEventListener('click', abrirNova);
      $(id + 'Codigo').addEventListener('input', aoDigitarCodigo);
      $(id + 'Add').addEventListener('click', adicionarFalta);
      qsa('[data-' + id + '-fechar]').forEach(function (b) {
        b.addEventListener('click', fecharSheets);
      });

      /* lista: delegação, porque as linhas são recriadas a cada render */
      var lista = $(id + 'Lista');
      /* clicar no componente abre a linha, revelando o "Suprida" */
      lista.addEventListener('click', function (ev) {
        if (ev.target.closest('.falta-sit, .falta-sup')) return;
        var linha = ev.target.closest('[data-' + id + '-linha]');
        if (linha) linha.classList.toggle('aberto');
      });

      lista.addEventListener('change', function (ev) {
        var alvo = ev.target;
        var linha = alvo.closest('[data-' + id + '-linha]');
        if (!linha) return;
        var faltaId = linha.getAttribute('data-' + id + '-linha');

        if (alvo.hasAttribute('data-' + id + '-suprir')) {
          suprir(faltaId);
          return;
        }
        if (alvo.hasAttribute('data-' + id + '-status')) {
          mudarStatus(faltaId, alvo.value);
        }
      });

      /* configurações */
      $(id + 'Notificar').addEventListener('click', function () {
        if (!window.Nuvem || !Nuvem.push) return;
        toast('Enviando notificação...');
        Nuvem.push.notificar(id, true).then(function (r) {
          toast(r && r.enviadas ? 'Notificação enviada (' + r.enviadas + ').'
                                  : 'Ninguém inscrito para receber.');
        })['catch'](function () { toast('Falha ao notificar.', 'err'); });
      });

      $(id + 'Sync').addEventListener('click', function () { sincronizar(false); });
      $(id + 'Sync2').addEventListener('click', function () { sincronizar(false); });
      $(id + 'Enviar').addEventListener('click', enviarComponentesDaqui);
      $(id + 'ExportCsv').addEventListener('click', exportarCsv);
      $(id + 'Apagar').addEventListener('click', apagarLocal);

      $(id + 'EscolherCsv').addEventListener('click', function () { $(id + 'FileCsv').click(); });
      $(id + 'FileCsv').addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        P.lerTexto(f, function (txt) { importarCsv(txt); });
        ev.target.value = '';
      });

      /* notificações */
      $(id + 'PushAtivar').addEventListener('click', function () {
        if (!window.Push) return;
        Push.ativar().then(function (msg) {
          toast(msg, 'ok');
          renderPush();
        }).catch(function (e) {
          toast(e.message, 'err');
          renderPush();
        });
      });
      $(id + 'PushDesativar').addEventListener('click', function () {
        if (!window.Push) return;
        Push.desativar().then(function () {
          toast('Notificações desativadas neste aparelho', 'ok');
          renderPush();
        });
      });
    }

    /* ---------- API da instância ---------- */
    return {
      cfg: cfg,
      preparar: function () {
        if (promessa) { promessa.then(function () { sincronizar(true); }); return promessa; }
        promessa = abrirBanco().then(function () {
          montarUI();
          render();
          statusNuvem();
          sincronizar(true);
        });
        return promessa;
      },
      aoMostrarView: function (nome) {
        if (!montado) return;
        if (nome === id + '-lista') { renderLista(); renderResumo(); }
        else if (nome === id + '-cfg') { renderStats(); statusNuvem(); }
      },
      fecharSheets: function () { if (montado) fecharSheets(); }
    };
  }

  var instancias = {};

  return {
    obter: function (cfg) {
      if (!instancias[cfg.id]) instancias[cfg.id] = criarInstancia(cfg);
      return instancias[cfg.id];
    },
    aoMostrarView: function (nome) {
      Object.keys(instancias).forEach(function (k) { instancias[k].aoMostrarView(nome); });
    }
  };
})();
