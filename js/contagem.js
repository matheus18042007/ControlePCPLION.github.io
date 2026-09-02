/* =========================================================
   Controle PCP LION — MÓDULO GENÉRICO DE CONTAGEM

   Usado hoje por dois módulos:
     • Contagem de Quadros VG  -> tabelas quadros / movimentacoes_quadros
     • Carenagens VG           -> tabelas carenagens / movimentacoes_carenagens

   Cada módulo tem o SEU PRÓPRIO banco SQLite, guardado em um
   IndexedDB separado (pcp_quadro, pcp_carenagem...). Nada aqui
   toca o banco do Almoxarifado PBA.

   Estrutura das tabelas (bem enxuta, é só para apoiar a
   contagem na produção):
     <tabela>      : codigo (Cod), nome (Nome), qtd (Qtd), data_cadastro
     <tabela>_mov  : histórico de toda alteração de quantidade

   Como a contagem é cíclica, as configurações do módulo têm a
   opção "Zerar quantidade de todos os itens".

   Para criar um módulo novo igual a estes, basta registrar
   outro cfg em MODULOS (js/app.js) — nada precisa ser copiado.
========================================================= */
window.ModuloContagem = (function () {
  'use strict';

  var instancias = {};

  /* ---------- IndexedDB próprio de cada módulo ---------- */
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
        var tx = d.transaction('kv', 'readonly');
        var rq = tx.objectStore('kv').get(key);
        rq.onsuccess = function () { d.close(); res(rq.result); };
        rq.onerror = function () { d.close(); rej(rq.error); };
      });
    });
  }

  /* ---------- CSV bem simples (separador ; ou ,) ---------- */
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
    var cab = parse(linhas[0]).map(function (h) {
      var s = h.toLowerCase();
      /* tira acentos para aceitar "descrição", "código" etc. */
      return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
    });
    return { cabecalho: cab, linhas: linhas.slice(1).map(parse) };
  }

  function num(v) {
    if (v == null || v === '') return 0;
    var s = String(v).replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  /* =======================================================
     Uma instância = um módulo de contagem
  ======================================================= */
  function criarInstancia(cfg) {
    var P = window.PCP;
    var $ = P.$, esc = P.esc, toast = P.toast;
    var id = cfg.id;                       // ex.: 'quadro'
    var TAB = cfg.tabela;                  // ex.: 'quadros'
    var MOV = cfg.tabelaMov;               // ex.: 'movimentacoes_quadros'
    var IDB = 'pcp_' + id;
    var UN = cfg.unidade || 'pç';

    var db = null, saveTimer = null, montado = false, promessa = null;
    var estado = { busca: '', movFiltro: 'TODOS', itemAtual: null, editando: false };

    var SCHEMA = [
      'CREATE TABLE IF NOT EXISTS ' + TAB + ' (',
      '  codigo TEXT PRIMARY KEY,',
      '  nome TEXT NOT NULL,',
      '  qtd REAL NOT NULL DEFAULT 0,',
      '  data_cadastro DATETIME',
      ');',
      'CREATE TABLE IF NOT EXISTS ' + MOV + ' (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  codigo_item TEXT NOT NULL,',
      '  tipo TEXT NOT NULL,',
      '  quantidade REAL NOT NULL,',
      '  qtd_final REAL,',
      '  data_hora DATETIME NOT NULL,',
      '  usuario TEXT,',
      '  observacao TEXT',
      ');',
      'CREATE INDEX IF NOT EXISTS ix_' + id + '_mov_item ON ' + MOV + '(codigo_item);',
      'CREATE INDEX IF NOT EXISTS ix_' + id + '_mov_data ON ' + MOV + '(data_hora);'
    ].join('\n');

    /* ---------- banco ---------- */
    function abrirBanco() {
      return initSqlJs({ locateFile: function (f) { return './vendor/' + f; } })
        .then(function (SQL) {
          return idbGet(IDB, 'dbfile').then(function (bytes) {
            if (bytes && bytes.byteLength) {
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
      clearTimeout(saveTimer);
      var run = function () {
        try {
          idbSet(IDB, 'dbfile', db.export()).then(function () {
            localStorage.setItem('ultimo_salvamento_' + id, P.agoraISO());
          });
        } catch (e) { toast('Erro ao salvar: ' + e.message, 'err'); }
      };
      if (imediato) run(); else saveTimer = setTimeout(run, 400);
    }

    function sel(sql, params) {
      var out = [], st = db.prepare(sql);
      if (params) st.bind(params);
      while (st.step()) out.push(st.getAsObject());
      st.free();
      return out;
    }
    function um(sql, params) { var r = sel(sql, params); return r.length ? r[0] : null; }
    function escalar(sql, params) {
      var r = um(sql, params);
      if (!r) return 0;
      return r[Object.keys(r)[0]];
    }

    /* ---------------------------------------------------
       NUVEM (Supabase)

       Igual ao almoxarifado: a nuvem é a fonte oficial e o
       SQLite local é só um cache para consultar offline.
       Toda gravação tenta a nuvem primeiro; se o cofre não
       estiver aberto (sem login), o app segue gravando só
       neste aparelho e avisa.
    --------------------------------------------------- */
    var apiNuvem = null;
    function nv() {
      if (!(window.Nuvem && Nuvem.ativa())) return null;
      if (!apiNuvem) apiNuvem = Nuvem.contagem(id);
      return apiNuvem;
    }

    /* substitui o cache local pelo conteúdo da nuvem */
    function gravarCache(dados) {
      db.run('BEGIN');
      try {
        db.run('DELETE FROM ' + MOV);
        db.run('DELETE FROM ' + TAB);
        dados.itens.forEach(function (it) {
          db.run('INSERT INTO ' + TAB + ' (codigo,nome,qtd,data_cadastro) VALUES (?,?,?,?)',
            [it.codigo, it.nome, Number(it.qtd) || 0, P.paraLocal(it.data_cadastro)]);
        });
        dados.movimentacoes.forEach(function (m) {
          db.run('INSERT INTO ' + MOV +
            ' (id,codigo_item,tipo,quantidade,qtd_final,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?,?,?)',
            [m.id, m.codigo_item, m.tipo, Number(m.quantidade) || 0,
             m.qtd_final == null ? null : Number(m.qtd_final),
             P.paraLocal(m.data_hora), m.usuario || null, m.observacao || null]);
        });
        db.run('COMMIT');
      } catch (e) {
        try { db.run('ROLLBACK'); } catch (e2) {}
        throw e;
      }
      salvar(true);
    }

    /* aplica no cache o item devolvido pela nuvem */
    function itemDaResposta(r) {
      if (!r) return null;
      return Array.isArray(r) ? (r[0] || null) : r;
    }
    function upsertLocal(it) {
      if (!it) return;
      if (um('SELECT codigo FROM ' + TAB + ' WHERE codigo = ?', [it.codigo])) {
        db.run('UPDATE ' + TAB + ' SET nome = ?, qtd = ? WHERE codigo = ?',
          [it.nome, Number(it.qtd) || 0, it.codigo]);
      } else {
        db.run('INSERT INTO ' + TAB + ' (codigo,nome,qtd,data_cadastro) VALUES (?,?,?,?)',
          [it.codigo, it.nome, Number(it.qtd) || 0, P.paraLocal(it.data_cadastro)]);
      }
    }

    function statusNuvem() {
      if (!montado) return;
      var n = window.Nuvem;
      var txt = 'Não configurado (faça login no cofre)';
      if (n && n.ativa()) txt = n.conectado() ? 'Conectado' : 'Sem conexão com a nuvem';
      $(id + 'NuvemEstado').textContent = txt;
      $(id + 'NuvemServidor').textContent = (n && n.ativa()) ? n.servidor() : '-';
      $(id + 'NuvemAparelho').textContent = (n && n.aparelho) ? n.aparelho() : '-';
      P.atualizarStatusNuvem();
    }

    function sincronizar(silencioso) {
      var api = nv();
      if (!api) { statusNuvem(); return Promise.resolve(false); }
      P.nuvemStatus('Sincronizando...', 'sync');

      return api.puxarTudo(null, function (nI, nM) {
        P.nuvemStatus('Baixando... ' + nI + ' itens' + (nM ? ' • ' + nM + ' mov.' : ''), 'sync');
      }).then(function (d) {
        /* trava: nuvem vazia NUNCA apaga o que já existe aqui.
           Nesse caso o certo é usar "Enviar itens deste aparelho". */
        if (!d.itens.length && escalar('SELECT COUNT(*) FROM ' + TAB) > 0) {
          statusNuvem();
          if (!silencioso) toast('A nuvem está vazia. Envie os itens deste aparelho primeiro.', 'err');
          return false;
        }
        gravarCache(d);
        statusNuvem();
        render();
        if (!silencioso) toast('Sincronizado • ' + d.itens.length + ' itens', 'ok');
        return true;
      }).catch(function (e) {
        statusNuvem();
        if (!silencioso) toast('Falha ao sincronizar: ' + e.message, 'err');
        return false;
      });
    }

    function enviarDaqui() {
      var api = nv();
      if (!api) { toast('Nuvem indisponível: faça login no cofre', 'err'); return; }
      var lista = sel('SELECT codigo, nome, qtd FROM ' + TAB + ' ORDER BY codigo');
      if (!lista.length) { toast('Nenhum item para enviar', 'err'); return; }
      if (!confirm('Enviar ' + lista.length + ' itens deste aparelho para a nuvem?\n' +
                   'Os que já existirem lá NÃO serão alterados.')) return;

      P.nuvemStatus('Enviando...', 'sync');
      api.enviarItens(lista, false).then(function () {
        toast('Itens enviados', 'ok');
        return sincronizar(false);
      }).catch(function (e) {
        statusNuvem();
        toast('Falha ao enviar: ' + e.message, 'err');
      });
    }

    /* aviso padrão de "gravou só aqui" */
    function semNuvem() {
      toast('Sem nuvem: gravado só neste aparelho', 'err');
    }

    /* ---------- HTML do módulo ---------- */
    function montarUI() {
      if (montado) return;
      montado = true;

      var main = $('main');
      var wrap = document.createElement('div');
      wrap.innerHTML = [
        /* ---------- ABA 1: CONTAGEM ---------- */
        '<section id="view-' + id + '-cont" class="view" data-modulo="' + id + '">',
        '  <div class="searchbar">',
        '    <input id="' + id + 'Busca" type="search" inputmode="search" placeholder="Buscar por código ou nome..." autocomplete="off">',
        '    <button id="' + id + 'LimpaBusca" class="icon-btn" type="button" aria-label="Limpar">&times;</button>',
        '  </div>',
        '  <div class="filters">',
        '    <span id="' + id + 'Resumo" class="muted small"></span>',
        '    <span class="grow"></span>',
        '    <button id="' + id + 'Novo" class="pill" type="button">+ Novo item</button>',
        '  </div>',
        '  <div id="' + id + 'Lista" class="list"></div>',
        '</section>',

        /* ---------- ABA 2: MOVIMENTAÇÕES ---------- */
        '<section id="view-' + id + '-mov" class="view" data-modulo="' + id + '">',
        '  <div class="searchbar">',
        '    <input id="' + id + 'BuscaMov" type="search" placeholder="Filtrar por código, nome, obs..." autocomplete="off">',
        '  </div>',
        '  <div class="filters">',
        '    <button class="pill active" data-' + id + 'mov="TODOS" type="button">Tudo</button>',
        '    <button class="pill" data-' + id + 'mov="ENTRADA" type="button">Entradas</button>',
        '    <button class="pill" data-' + id + 'mov="SAIDA" type="button">Saídas</button>',
        '    <button class="pill" data-' + id + 'mov="ZERAGEM" type="button">Zeragens</button>',
        '  </div>',
        '  <div id="' + id + 'ListaMov" class="list"></div>',
        '</section>',

        /* ---------- ABA 3: CONFIGURAÇÕES ---------- */
        '<section id="view-' + id + '-cfg" class="view" data-modulo="' + id + '">',
        '  <div class="card">',
        '    <h3>Contagem cíclica</h3>',
        '    <p class="muted small warn">Zera a quantidade (Qtd) de <b>todos</b> os itens deste módulo para recomeçar a contagem. O cadastro dos itens e o histórico são mantidos.</p>',
        '    <button id="' + id + 'Zerar" class="btn danger block" type="button">🔄 Zerar quantidade de todos os itens</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Banco na nuvem (Supabase)</h3>',
        '    <p class="muted small">Este módulo usa o mesmo banco oficial do app, na tabela <code>contagem_itens</code> com <code>modulo = "' + id + '"</code>. Não há nada para configurar aqui.</p>',
        '    <div class="kv"><span>Situação</span><b id="' + id + 'NuvemEstado">-</b></div>',
        '    <div class="kv"><span>Servidor</span><b id="' + id + 'NuvemServidor">-</b></div>',
        '    <div class="kv"><span>Aparelho</span><b id="' + id + 'NuvemAparelho">-</b></div>',
        '    <button id="' + id + 'Sync" class="btn primary block" type="button">🔄 Sincronizar agora</button>',
        '    <button id="' + id + 'Enviar" class="btn ghost block" type="button">⬆ Enviar itens deste aparelho para a nuvem</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Cadastro manual</h3>',
        '    <button id="' + id + 'Novo2" class="btn ghost block" type="button">+ Novo item</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Importar itens (CSV)</h3>',
        '    <p class="muted small">Colunas aceitas: <code>cod;nome;qtd</code> (ou <code>codigo;nome;quantidade</code>). Separador <code>;</code> ou <code>,</code>.</p>',
        '    <label class="check"><input type="checkbox" id="' + id + 'CsvAtualizaQtd"> Atualizar a Qtd dos itens já existentes</label>',
        '    <input type="file" id="' + id + 'FileCsv" accept=".csv,.txt" hidden>',
        '    <button id="' + id + 'EscolherCsv" class="btn primary block" type="button">Escolher arquivo CSV</button>',
        '    <div id="' + id + 'CsvResultado" class="muted small"></div>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Excluir item</h3>',
        '    <p class="muted small warn">Apaga o código <b>de vez</b>, junto com todo o histórico dele.</p>',
        '    <input id="' + id + 'ExcluirCodigo" type="text" placeholder="Código do item" autocomplete="off" autocapitalize="characters" spellcheck="false">',
        '    <button id="' + id + 'Excluir" class="btn danger block" type="button">🗑 Excluir item</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Exportar</h3>',
        '    <p class="muted small">Gere o arquivo para levar ao PC (pasta <em>Downloads</em>).</p>',
        '    <button id="' + id + 'ExportCsv" class="btn primary block" type="button">⬇ Exportar itens (.csv)</button>',
        '    <button id="' + id + 'ExportCsvMov" class="btn ghost block" type="button">⬇ Exportar movimentações (.csv)</button>',
        '    <button id="' + id + 'ExportDb" class="btn ghost block" type="button">⬇ Exportar banco (.db SQLite)</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Este módulo</h3>',
        '    <p class="muted small">Banco local próprio (cache offline), separado do Almoxarifado PBA.</p>',
        '    <div class="kv"><span>Tabelas locais</span><b>' + TAB + ' / ' + MOV + '</b></div>',
        '    <div class="kv"><span>Itens</span><b id="' + id + 'StatItens">0</b></div>',
        '    <div class="kv"><span>Movimentações</span><b id="' + id + 'StatMov">0</b></div>',
        '    <div class="kv"><span>Qtd total contada</span><b id="' + id + 'StatQtd">0</b></div>',
        '    <div class="kv"><span>Último salvamento</span><b id="' + id + 'StatSalvo">-</b></div>',
        '    <button id="' + id + 'Apagar" class="btn danger block" type="button">🗑 Limpar cópia local deste módulo</button>',
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
        '<button class="tab active" data-view="' + id + '-cont" type="button"><span>🔢</span>Contagem</button>',
        '<button class="tab" data-view="' + id + '-mov" type="button"><span>🕘</span>Movimentações</button>',
        '<button class="tab" data-view="' + id + '-cfg" type="button"><span>⚙</span>Configurações</button>'
      ].join('');
      document.body.appendChild(nav);

      /* ---------- sheets ---------- */
      var sheets = document.createElement('div');
      sheets.innerHTML = [
        '<div id="' + id + 'SheetQtd" class="sheet-wrap" data-modulo="' + id + '">',
        '  <div class="sheet">',
        '    <div class="sheet-handle"></div>',
        '    <h3>Definir quantidade</h3>',
        '    <div class="mov-item">',
        '      <b id="' + id + 'QtdNome">-</b>',
        '      <small id="' + id + 'QtdAtual" class="muted"></small>',
        '    </div>',
        '    <label class="lbl">Quantidade contada</label>',
        '    <div class="qty">',
        '      <button class="qty-btn" data-' + id + 'passo="-1" type="button">-</button>',
        '      <input id="' + id + 'QtdInput" type="number" inputmode="decimal" step="any" min="0" value="0">',
        '      <button class="qty-btn" data-' + id + 'passo="1" type="button">+</button>',
        '    </div>',
        '    <div class="quick-qty">',
        '      <button type="button" data-' + id + 'set="0">0</button>',
        '      <button type="button" data-' + id + 'set="10">10</button>',
        '      <button type="button" data-' + id + 'set="50">50</button>',
        '      <button type="button" data-' + id + 'set="100">100</button>',
        '    </div>',
        '    <label class="lbl">Observação (opcional)</label>',
        '    <input id="' + id + 'QtdObs" type="text" placeholder="Ex.: contagem do turno, sobra de linha...">',
        '    <div id="' + id + 'QtdPrevia" class="previa"></div>',
        '    <div class="sheet-actions">',
        '      <button class="btn ghost" data-' + id + 'fechar="1" type="button">Cancelar</button>',
        '      <button id="' + id + 'QtdSalvar" class="btn primary" type="button">Confirmar</button>',
        '    </div>',
        '  </div>',
        '</div>',
        '<div id="' + id + 'SheetCad" class="sheet-wrap" data-modulo="' + id + '">',
        '  <div class="sheet">',
        '    <div class="sheet-handle"></div>',
        '    <h3 id="' + id + 'CadTitulo">Novo item</h3>',
        '    <label class="lbl">Cod *</label>',
        '    <input id="' + id + 'CadCodigo" type="text" autocapitalize="characters" autocomplete="off">',
        '    <label class="lbl">Nome *</label>',
        '    <input id="' + id + 'CadNome" type="text" autocomplete="off">',
        '    <div id="' + id + 'CadQtdWrap">',
        '      <label class="lbl">Qtd inicial</label>',
        '      <input id="' + id + 'CadQtd" type="number" step="any" value="0">',
        '    </div>',
        '    <div class="sheet-actions">',
        '      <button class="btn ghost" data-' + id + 'fechar="1" type="button">Cancelar</button>',
        '      <button id="' + id + 'CadSalvar" class="btn primary" type="button">Salvar</button>',
        '    </div>',
        '  </div>',
        '</div>'
      ].join('\n');
      while (sheets.firstChild) document.body.appendChild(sheets.firstChild);

      ligarEventos();
    }

    /* ---------- sheets: abrir/fechar ---------- */
    function fecharSheets() {
      $(id + 'SheetQtd').classList.remove('open');
      $(id + 'SheetCad').classList.remove('open');
    }

    function abrirQtd(codigo) {
      var it = um('SELECT * FROM ' + TAB + ' WHERE codigo = ?', [codigo]);
      if (!it) { toast('Item não encontrado', 'err'); return; }
      estado.itemAtual = it;
      $(id + 'QtdNome').textContent = it.codigo + ' — ' + it.nome;
      $(id + 'QtdAtual').textContent = 'Qtd atual: ' + P.fmtNum(it.qtd) + ' ' + UN;
      $(id + 'QtdInput').value = it.qtd;
      $(id + 'QtdObs').value = '';
      previaQtd();
      $(id + 'SheetQtd').classList.add('open');
      setTimeout(function () { $(id + 'QtdInput').select(); }, 120);
    }

    function previaQtd() {
      var it = estado.itemAtual;
      if (!it) return;
      var nova = num($(id + 'QtdInput').value);
      var d = nova - it.qtd;
      var txt = d === 0
        ? 'Sem alteração na quantidade.'
        : (P.fmtNum(it.qtd) + ' → ' + P.fmtNum(nova) + '  (' + (d > 0 ? '+' : '') + P.fmtNum(d) + ')');
      $(id + 'QtdPrevia').textContent = txt;
    }

    /* grava a mudança de quantidade no cache local + histórico */
    function aplicarLocal(codigo, qtdFinal, delta, obs) {
      db.run('UPDATE ' + TAB + ' SET qtd = ? WHERE codigo = ?', [qtdFinal, codigo]);
      db.run(
        'INSERT INTO ' + MOV + ' (codigo_item,tipo,quantidade,qtd_final,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?,?)',
        [codigo, delta > 0 ? 'ENTRADA' : 'SAIDA', Math.abs(delta), qtdFinal,
         P.agoraISO(), P.operador() || null, obs || null]
      );
      salvar(true);
    }

    function confirmarQtd() {
      var it = estado.itemAtual;
      if (!it) return;
      var nova = num($(id + 'QtdInput').value);
      if (nova < 0) { toast('Quantidade não pode ser negativa', 'err'); return; }
      var d = nova - it.qtd;
      if (d === 0) { fecharSheets(); return; }
      var obs = $(id + 'QtdObs').value.trim();

      var ok = function (qtdFinal) {
        fecharSheets();
        P.vibrar(60);
        P.bip(qtdFinal >= it.qtd ? 1046 : 700, 0.1);
        toast('Qtd de ' + it.codigo + ': ' + P.fmtNum(qtdFinal), 'ok');
        render();
      };

      var api = nv();
      if (!api) { aplicarLocal(it.codigo, nova, d, obs); semNuvem(); ok(nova); return; }

      var btn = $(id + 'QtdSalvar');
      var rotulo = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Gravando na nuvem...';

      /* absoluto: "a quantidade contada agora é esta" */
      api.definir(it.codigo, nova, true, P.operador(), obs)
        .then(function (r) {
          var novoItem = itemDaResposta(r);
          var final = novoItem ? Number(novoItem.qtd) : nova;
          upsertLocal(novoItem);
          aplicarLocal(it.codigo, final, final - it.qtd, obs);
          statusNuvem();
          ok(final);
        })
        .catch(function (e) {
          statusNuvem();
          P.vibrar([80, 60, 80]);
          P.bip(220, 0.25);
          toast('NÃO gravado: ' + e.message, 'err');
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = rotulo;
        });
    }

    /* passo rápido direto na lista (- / +) */
    function passo(codigo, d) {
      var it = um('SELECT * FROM ' + TAB + ' WHERE codigo = ?', [codigo]);
      if (!it) return;
      if (it.qtd + d < 0) { P.vibrar(80); return; }

      var api = nv();
      if (!api) {
        aplicarLocal(codigo, it.qtd + d, d, 'contagem rápida');
        P.vibrar(25);
        render();
        return;
      }

      /* relativo (+1 / -1): o servidor soma em cima do valor
         oficial, então dois celulares contando juntos não se
         atropelam - nenhuma peça é perdida na soma. */
      api.definir(codigo, d, false, P.operador(), 'contagem rápida')
        .then(function (r) {
          var novoItem = itemDaResposta(r);
          var final = novoItem ? Number(novoItem.qtd) : (it.qtd + d);
          upsertLocal(novoItem);
          aplicarLocal(codigo, final, d, 'contagem rápida');
          P.vibrar(25);
          statusNuvem();
          render();
        })
        .catch(function (e) {
          P.vibrar([80, 60, 80]);
          statusNuvem();
          toast('NÃO gravado: ' + e.message, 'err');
        });
    }

    /* ---------- cadastro ---------- */
    function abrirCadastro(item) {
      estado.editando = !!item;
      $(id + 'CadTitulo').textContent = item ? 'Editar item' : 'Novo item';
      $(id + 'CadCodigo').value = item ? item.codigo : '';
      $(id + 'CadCodigo').readOnly = !!item;
      $(id + 'CadNome').value = item ? item.nome : '';
      $(id + 'CadQtd').value = item ? item.qtd : 0;
      $(id + 'CadQtdWrap').classList.toggle('hidden', !!item);
      $(id + 'SheetCad').classList.add('open');
    }

    function salvarCadastro() {
      var cod = $(id + 'CadCodigo').value.trim().toUpperCase();
      var nome = $(id + 'CadNome').value.trim();
      if (!cod || !nome) { toast('Informe Cod e Nome', 'err'); return; }

      if (!estado.editando && um('SELECT codigo FROM ' + TAB + ' WHERE codigo = ?', [cod])) {
        toast('Já existe um item com esse código', 'err'); return;
      }
      var q = estado.editando ? 0 : num($(id + 'CadQtd').value);

      var localmente = function () {
        if (estado.editando) {
          db.run('UPDATE ' + TAB + ' SET nome = ? WHERE codigo = ?', [nome, cod]);
        } else {
          db.run('INSERT INTO ' + TAB + ' (codigo,nome,qtd,data_cadastro) VALUES (?,?,?,?)',
            [cod, nome, q, P.agoraISO()]);
          if (q !== 0) {
            db.run(
              'INSERT INTO ' + MOV + ' (codigo_item,tipo,quantidade,qtd_final,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?,?)',
              [cod, 'ENTRADA', q, q, P.agoraISO(), P.operador() || null, 'cadastro do item']
            );
          }
        }
        salvar(true);
        fecharSheets();
        toast('Item salvo', 'ok');
        render();
      };

      var api = nv();
      if (!api) { localmente(); semNuvem(); return; }

      var btn = $(id + 'CadSalvar');
      var rotulo = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Gravando na nuvem...';

      api.cadastrar(cod, nome, q, P.operador())
        .then(function (r) {
          upsertLocal(itemDaResposta(r));
          if (!estado.editando && q !== 0) {
            db.run(
              'INSERT INTO ' + MOV + ' (codigo_item,tipo,quantidade,qtd_final,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?,?)',
              [cod, 'ENTRADA', q, q, P.agoraISO(), P.operador() || null, 'cadastro do item']
            );
          }
          salvar(true);
          statusNuvem();
          fecharSheets();
          toast('Item salvo', 'ok');
          render();
        })
        .catch(function (e) {
          statusNuvem();
          toast('NÃO gravado: ' + e.message, 'err');
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = rotulo;
        });
    }

    /* ---------- zerar (contagem cíclica) ---------- */
    function zerarTudo() {
      var n = escalar('SELECT COUNT(*) FROM ' + TAB + ' WHERE qtd <> 0');
      if (!n) { toast('Todos os itens já estão zerados', 'ok'); return; }
      if (!confirm('Zerar a quantidade de ' + n + ' item(ns) de "' + cfg.nome + '"?\n\nO cadastro e o histórico continuam salvos. Não dá para desfazer.')) return;
      if (!confirm('Confirma mesmo? A contagem atual será perdida.')) return;

      var localmente = function () {
        var agora = P.agoraISO(), op = P.operador() || null;
        sel('SELECT codigo, qtd FROM ' + TAB + ' WHERE qtd <> 0').forEach(function (r) {
          db.run(
            'INSERT INTO ' + MOV + ' (codigo_item,tipo,quantidade,qtd_final,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?,?)',
            [r.codigo, 'ZERAGEM', r.qtd, 0, agora, op, 'zeragem geral (contagem cíclica)']
          );
        });
        db.run('UPDATE ' + TAB + ' SET qtd = 0');
        salvar(true);
        P.vibrar([60, 50, 60]);
        toast(n + ' item(ns) zerado(s). Pode começar a contagem.', 'ok');
        render();
      };

      var api = nv();
      if (!api) { localmente(); semNuvem(); return; }

      var btn = $(id + 'Zerar');
      var rotulo = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Zerando na nuvem...';

      /* uma chamada só: o servidor grava as ZERAGEM e zera tudo
         na mesma transação, para todos os aparelhos de uma vez */
      api.zerar(P.operador(), null)
        .then(function (qtos) {
          statusNuvem();
          P.vibrar([60, 50, 60]);
          toast((qtos == null ? n : qtos) + ' item(ns) zerado(s) na nuvem.', 'ok');
          return sincronizar(true);
        })
        .catch(function (e) {
          statusNuvem();
          toast('NÃO zerado: ' + e.message, 'err');
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = rotulo;
        });
    }

    /* ---------- renderização ---------- */
    function render() {
      renderLista();
      renderMov();
      renderStats();
    }

    function renderLista() {
      var termo = ($(id + 'Busca').value || '').trim().toLowerCase();
      var sql = 'SELECT * FROM ' + TAB, par = [];
      if (termo) {
        sql += ' WHERE LOWER(codigo) LIKE ? OR LOWER(nome) LIKE ?';
        par = ['%' + termo + '%', '%' + termo + '%'];
      }
      sql += ' ORDER BY codigo';
      var linhas = sel(sql, par);

      var total = escalar('SELECT COUNT(*) FROM ' + TAB);
      var somaQtd = escalar('SELECT IFNULL(SUM(qtd),0) FROM ' + TAB);
      var contados = escalar('SELECT COUNT(*) FROM ' + TAB + ' WHERE qtd > 0');
      $(id + 'Resumo').textContent =
        total + ' itens • ' + contados + ' contados • total ' + P.fmtNum(somaQtd) + ' ' + UN;

      var el = $(id + 'Lista');
      if (!linhas.length) {
        el.innerHTML = '<div class="vazio">' +
          (total ? 'Nenhum item encontrado para essa busca.'
                 : 'Nenhum item cadastrado ainda.<br>Use "+ Novo item" ou importe um CSV nas configurações.') +
          '</div>';
        return;
      }

      el.innerHTML = linhas.map(function (r) {
        return '<div class="li' + (r.qtd > 0 ? ' contado' : '') + '">' +
          '<div class="li-main" data-' + id + 'abrir="' + esc(r.codigo) + '">' +
            '<span class="li-code">' + esc(r.codigo) + '</span>' +
            '<span class="li-nome">' + esc(r.nome) + '</span>' +
          '</div>' +
          '<div class="li-cont">' +
            '<button class="qty-btn" data-' + id + 'passo2="-1" data-cod="' + esc(r.codigo) + '" type="button">-</button>' +
            '<button class="li-qtd" data-' + id + 'abrir="' + esc(r.codigo) + '" type="button">' + P.fmtNum(r.qtd) + '</button>' +
            '<button class="qty-btn" data-' + id + 'passo2="1" data-cod="' + esc(r.codigo) + '" type="button">+</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderMov() {
      var termo = ($(id + 'BuscaMov').value || '').trim().toLowerCase();
      var sql = 'SELECT m.*, i.nome AS nome FROM ' + MOV + ' m LEFT JOIN ' + TAB + ' i ON i.codigo = m.codigo_item';
      var cond = [], par = [];
      if (estado.movFiltro !== 'TODOS') { cond.push('m.tipo = ?'); par.push(estado.movFiltro); }
      if (termo) {
        cond.push('(LOWER(m.codigo_item) LIKE ? OR LOWER(IFNULL(i.nome,"")) LIKE ? OR LOWER(IFNULL(m.observacao,"")) LIKE ?)');
        par.push('%' + termo + '%', '%' + termo + '%', '%' + termo + '%');
      }
      if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
      sql += ' ORDER BY m.id DESC LIMIT 400';

      var linhas = sel(sql, par);
      var el = $(id + 'ListaMov');
      if (!linhas.length) {
        el.innerHTML = '<div class="vazio">Nenhuma movimentação registrada.</div>';
        return;
      }
      el.innerHTML = linhas.map(function (m) {
        var cls = m.tipo === 'ENTRADA' ? 'e' : (m.tipo === 'ZERAGEM' ? 'z' : 's');
        var sinal = m.tipo === 'ENTRADA' ? '+' : '-';
        return '<div class="li">' +
          '<div class="li-main">' +
            '<span class="li-code">' + esc(m.codigo_item) + '</span>' +
            '<span class="li-nome">' + esc(m.nome || '(item excluído)') + '</span>' +
            '<span class="li-sub">' + P.fmtDataHora(m.data_hora) +
              (m.usuario ? ' • ' + esc(m.usuario) : '') +
              (m.observacao ? ' • ' + esc(m.observacao) : '') +
            '</span>' +
          '</div>' +
          '<div class="li-saldo-txt">' +
            '<span class="badge ' + cls + '">' + (m.tipo === 'ZERAGEM' ? 'zerou' : sinal + P.fmtNum(m.quantidade)) + '</span>' +
            '<small class="muted">ficou ' + P.fmtNum(m.qtd_final) + '</small>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderStats() {
      $(id + 'StatItens').textContent = escalar('SELECT COUNT(*) FROM ' + TAB);
      $(id + 'StatMov').textContent = escalar('SELECT COUNT(*) FROM ' + MOV);
      $(id + 'StatQtd').textContent = P.fmtNum(escalar('SELECT IFNULL(SUM(qtd),0) FROM ' + TAB));
      $(id + 'StatSalvo').textContent =
        P.fmtDataHora(localStorage.getItem('ultimo_salvamento_' + id)) || '-';
    }

    /* ---------- importação / exportação ---------- */
    function importarCsv(texto) {
      var d = lerCsv(texto);
      var iCod = -1, iNome = -1, iQtd = -1;
      d.cabecalho.forEach(function (h, i) {
        if (iCod < 0 && (h === 'cod' || h === 'codigo' || h === 'code')) iCod = i;
        if (iNome < 0 && (h === 'nome' || h === 'descricao' || h === 'item')) iNome = i;
        if (iQtd < 0 && (h === 'qtd' || h === 'quantidade' || h === 'qty')) iQtd = i;
      });
      if (iCod < 0 || iNome < 0) {
        $(id + 'CsvResultado').textContent = 'CSV sem as colunas "cod" e "nome".';
        return;
      }
      var atualiza = $(id + 'CsvAtualizaQtd').checked;
      var novos = 0, atualizados = 0, pulados = 0, agora = P.agoraISO();

      /* linhas válidas, já limpas */
      var lista = [];
      d.linhas.forEach(function (l) {
        var cod = (l[iCod] || '').trim().toUpperCase();
        var nome = (l[iNome] || '').trim();
        if (!cod || !nome) { pulados++; return; }
        lista.push({ codigo: cod, nome: nome, qtd: iQtd >= 0 ? num(l[iQtd]) : 0 });
      });
      if (!lista.length) {
        $(id + 'CsvResultado').textContent = 'Nenhuma linha válida no arquivo.';
        return;
      }

      var api = nv();
      if (api) {
        /* a nuvem é a fonte oficial: manda para lá e baixa de volta */
        $(id + 'CsvResultado').textContent = 'Enviando ' + lista.length + ' linha(s) para a nuvem...';
        P.nuvemStatus('Enviando...', 'sync');
        api.enviarItens(lista, atualiza).then(function () {
          $(id + 'CsvResultado').textContent =
            lista.length + ' linha(s) enviada(s)' + (pulados ? ', ' + pulados + ' ignorada(s)' : '') +
            (atualiza ? '' : ' (itens que já existiam foram mantidos)') + '.';
          toast('Importação concluída', 'ok');
          return sincronizar(true);
        }).catch(function (e) {
          statusNuvem();
          $(id + 'CsvResultado').textContent = 'Falha ao enviar: ' + e.message;
          toast('NÃO importado: ' + e.message, 'err');
        });
        return;
      }

      lista.forEach(function (r) {
        var cod = r.codigo, nome = r.nome, q = r.qtd;
        var ex = um('SELECT codigo FROM ' + TAB + ' WHERE codigo = ?', [cod]);
        if (ex) {
          if (atualiza) db.run('UPDATE ' + TAB + ' SET nome = ?, qtd = ? WHERE codigo = ?', [nome, q, cod]);
          else db.run('UPDATE ' + TAB + ' SET nome = ? WHERE codigo = ?', [nome, cod]);
          atualizados++;
        } else {
          db.run('INSERT INTO ' + TAB + ' (codigo,nome,qtd,data_cadastro) VALUES (?,?,?,?)', [cod, nome, q, agora]);
          novos++;
        }
      });
      salvar(true);
      $(id + 'CsvResultado').textContent =
        novos + ' novo(s), ' + atualizados + ' atualizado(s)' + (pulados ? ', ' + pulados + ' linha(s) ignorada(s)' : '') +
        ' — só neste aparelho (sem nuvem).';
      toast('Importação concluída', 'ok');
      render();
    }

    function excluirItem() {
      var cod = $(id + 'ExcluirCodigo').value.trim().toUpperCase();
      if (!cod) { toast('Informe o código', 'err'); return; }
      var it = um('SELECT * FROM ' + TAB + ' WHERE codigo = ?', [cod]);
      if (!it) { toast('Código não encontrado', 'err'); return; }
      var n = escalar('SELECT COUNT(*) FROM ' + MOV + ' WHERE codigo_item = ?', [cod]);
      if (!confirm('Excluir "' + it.nome + '" (' + cod + ') e ' + n + ' movimentação(ões)?\nNão tem como desfazer.')) return;

      var localmente = function () {
        db.run('DELETE FROM ' + MOV + ' WHERE codigo_item = ?', [cod]);
        db.run('DELETE FROM ' + TAB + ' WHERE codigo = ?', [cod]);
        salvar(true);
        $(id + 'ExcluirCodigo').value = '';
        toast('Item excluído', 'ok');
        render();
      };

      var api = nv();
      if (!api) { localmente(); semNuvem(); return; }

      /* apaga na nuvem (para todo mundo) e depois aqui */
      api.excluir(cod, P.operador())
        .then(function () { statusNuvem(); localmente(); })
        .catch(function (e) {
          statusNuvem();
          toast('NÃO excluído: ' + e.message, 'err');
        });
    }

    function apagarTudo() {
      if (!confirm('Limpar a cópia local de "' + cfg.nome + '" NESTE APARELHO?\n' +
                   'Nada é apagado da nuvem: ao sincronizar, tudo volta.\n' +
                   'Serve para resolver bagunça no cache. Os outros módulos não são afetados.')) return;
      if (!confirm('Última confirmação: limpar a cópia local deste módulo?')) return;
      db.run('DELETE FROM ' + MOV + '; DELETE FROM ' + TAB + ';');
      salvar(true);
      toast('Cópia local apagada', 'ok');
      render();
    }

    /* ---------- eventos ---------- */
    function ligarEventos() {
      var tBusca = null;
      $(id + 'Busca').addEventListener('input', function () {
        clearTimeout(tBusca); tBusca = setTimeout(renderLista, 180);
      });
      $(id + 'LimpaBusca').addEventListener('click', function () {
        $(id + 'Busca').value = ''; renderLista();
      });
      $(id + 'Novo').addEventListener('click', function () { abrirCadastro(null); });
      $(id + 'Novo2').addEventListener('click', function () { abrirCadastro(null); });

      /* lista: abrir sheet de quantidade ou usar - / + */
      $(id + 'Lista').addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-' + id + 'passo2]');
        if (b) { passo(b.getAttribute('data-cod'), parseFloat(b.getAttribute('data-' + id + 'passo2'))); return; }
        var a = ev.target.closest('[data-' + id + 'abrir]');
        if (a) abrirQtd(a.getAttribute('data-' + id + 'abrir'));
      });

      /* movimentações */
      var tMov = null;
      $(id + 'BuscaMov').addEventListener('input', function () {
        clearTimeout(tMov); tMov = setTimeout(renderMov, 180);
      });
      P.qsa('[data-' + id + 'mov]').forEach(function (b) {
        b.addEventListener('click', function () {
          estado.movFiltro = b.getAttribute('data-' + id + 'mov');
          P.qsa('[data-' + id + 'mov]').forEach(function (o) {
            o.classList.toggle('active', o === b);
          });
          renderMov();
        });
      });

      /* sheet de quantidade */
      $(id + 'QtdInput').addEventListener('input', previaQtd);
      P.qsa('[data-' + id + 'passo]').forEach(function (b) {
        b.addEventListener('click', function () {
          var v = num($(id + 'QtdInput').value) + parseFloat(b.getAttribute('data-' + id + 'passo'));
          $(id + 'QtdInput').value = Math.max(0, v);
          previaQtd();
        });
      });
      P.qsa('[data-' + id + 'set]').forEach(function (b) {
        b.addEventListener('click', function () {
          $(id + 'QtdInput').value = b.getAttribute('data-' + id + 'set');
          previaQtd();
        });
      });
      $(id + 'QtdSalvar').addEventListener('click', confirmarQtd);
      $(id + 'CadSalvar').addEventListener('click', salvarCadastro);
      P.qsa('[data-' + id + 'fechar]').forEach(function (b) {
        b.addEventListener('click', fecharSheets);
      });

      /* configurações */
      $(id + 'Sync').addEventListener('click', function () { sincronizar(false); });
      $(id + 'Enviar').addEventListener('click', enviarDaqui);
      $(id + 'Zerar').addEventListener('click', zerarTudo);
      $(id + 'Excluir').addEventListener('click', excluirItem);
      $(id + 'Apagar').addEventListener('click', apagarTudo);
      $(id + 'EscolherCsv').addEventListener('click', function () { $(id + 'FileCsv').click(); });
      $(id + 'FileCsv').addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () { importarCsv(String(fr.result)); };
        fr.readAsText(f, 'utf-8');
        ev.target.value = '';
      });
      $(id + 'ExportCsv').addEventListener('click', function () {
        var cols = ['codigo', 'nome', 'qtd', 'data_cadastro'];
        var txt = P.csvDe(cols, sel('SELECT ' + cols.join(',') + ' FROM ' + TAB + ' ORDER BY codigo'));
        P.baixar(new Blob([txt], { type: 'text/csv;charset=utf-8' }), id + '_itens_' + P.carimbo() + '.csv');
        toast('CSV gerado (pasta Downloads)', 'ok');
      });
      $(id + 'ExportCsvMov').addEventListener('click', function () {
        var cols = ['id', 'codigo_item', 'tipo', 'quantidade', 'qtd_final', 'data_hora', 'usuario', 'observacao'];
        var txt = P.csvDe(cols, sel('SELECT ' + cols.join(',') + ' FROM ' + MOV + ' ORDER BY id'));
        P.baixar(new Blob([txt], { type: 'text/csv;charset=utf-8' }), id + '_movimentacoes_' + P.carimbo() + '.csv');
        toast('CSV gerado (pasta Downloads)', 'ok');
      });
      $(id + 'ExportDb').addEventListener('click', function () {
        try {
          P.baixar(new Blob([db.export()], { type: 'application/x-sqlite3' }), id + '_' + P.carimbo() + '.db');
          toast('Arquivo .db gerado (pasta Downloads)', 'ok');
        } catch (e) { toast('Erro ao exportar: ' + e.message, 'err'); }
      });

      /* abas do módulo */
      P.qsa('#tabbar-' + id + ' .tab').forEach(function (t) {
        t.addEventListener('click', function () { P.mostrarView(t.dataset.view); });
      });
    }

    /* ---------- API da instância ---------- */
    return {
      cfg: cfg,
      /* carrega o banco e monta a tela uma única vez */
      preparar: function () {
        /* já preparado: só confere se tem novidade na nuvem */
        if (promessa) { promessa.then(function () { sincronizar(true); }); return promessa; }
        promessa = abrirBanco().then(function () {
          montarUI();
          render();
          statusNuvem();
          /* mostra o cache na hora e busca o oficial em segundo
             plano - não trava a entrada no módulo */
          sincronizar(true);
        });
        return promessa;
      },
      aoMostrarView: function (nome) {
        if (nome === id + '-cont') renderLista();
        else if (nome === id + '-mov') renderMov();
        else if (nome === id + '-cfg') { renderStats(); statusNuvem(); }
      },
      fecharSheets: fecharSheets
    };
  }

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
