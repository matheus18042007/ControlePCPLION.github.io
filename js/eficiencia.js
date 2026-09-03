/* =========================================================
   Controle PCP LION — MÓDULO EFICIÊNCIA VG

   Controle DIÁRIO de faltas e horas extras da produção.

   Diferença para os módulos de contagem: aqui a folha é do
   DIA. Você marca todo mundo, clica em "Finalizar eficiência"
   e o dia inteiro vai para o histórico carimbado com a data,
   deixando a folha limpa para o dia seguinte.

   Tabelas locais (banco próprio, IndexedDB pcp_eficiencia):
     colaboradores   : id, setor (Setor), nome (Colaborador),
                       situacao (Situação), hora (Hora)
                       -> é a folha do dia em aberto
     eficiencia_dias : setor, nome, situacao, hora, data (Data)
                       -> histórico, mantido por 10 dias

   Situação guarda só o código, como pedido:
     'I' = dia todo | 'P' = parcial | '' = falta

   Nada aqui toca o banco do Almoxarifado PBA nem o dos
   módulos de contagem.
========================================================= */
window.ModuloEficiencia = (function () {
  'use strict';

  /* quantos dias de histórico o módulo guarda */
  var DIAS_HISTORICO = 10;

  var SITUACOES = [
    { cod: 'I', label: 'I - Dia todo' },
    { cod: 'P', label: 'P - Parcial' },
    { cod: '',  label: 'Falta' }
  ];

  /* ---------------------------------------------------------
     Camada de banco (IndexedDB + SQLite)

     Mesma receita usada em js/contagem.js. Está repetida aqui
     de propósito: cada módulo abre o SEU banco e um não pode
     derrubar o outro se precisar mudar de schema.
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

  /* ---------- datas (YYYY-MM-DD, sem fuso para atrapalhar) ---------- */
  function hoje() {
    var d = new Date(), p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function dataBR(iso) {
    if (!iso) return '-';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? (m[3] + '/' + m[2] + '/' + m[1]) : iso;
  }
  /* data limite do histórico: hoje - DIAS_HISTORICO */
  function limiteHistorico() {
    var d = new Date();
    d.setDate(d.getDate() - DIAS_HISTORICO);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* id estável do colaborador: mesmo setor + mesmo nome = mesma
     pessoa em qualquer aparelho, o que faz o merge na nuvem
     funcionar sem depender de sequência local */
  function semAcento(s) {
    s = String(s == null ? '' : s);
    return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
  }
  function chave(setor, nome) {
    var slug = function (s) {
      return semAcento(s).trim().toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    };
    return slug(setor) + ':' + slug(nome);
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
    var cab = parse(linhas[0]).map(function (h) { return semAcento(h).toLowerCase(); });
    return { cabecalho: cab, linhas: linhas.slice(1).map(parse) };
  }

  /* horas: aceita 1.5 (input number) e 1,5 (digitado a mao).
     So trata o ponto como separador de milhar quando existe
     uma virgula decimal na frente - senao 1.5 viraria 15. */
  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    var s = String(v).replace(/\s/g, '');
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  /* normaliza o que o usuário digitar na situação para I / P / '' */
  function normSituacao(v) {
    var s = String(v || '').trim().toUpperCase();
    if (s === 'I' || s === 'P') return s;
    return '';
  }

  /* =========================================================
     A instância do módulo
  ========================================================= */
  function criarInstancia(cfg) {
    var P = window.PCP;
    var $ = P.$, qsa = P.qsa, esc = P.esc, toast = P.toast;

    var id = cfg.id;                        // ex.: 'eficiencia'
    var IDB = 'pcp_' + id;
    var db = null, saveTimer = null, montado = false, promessa = null;
    var estado = { busca: '', setor: 'TODOS', histData: 'TODAS', apiNuvem: null };

    var SCHEMA = [
      'CREATE TABLE IF NOT EXISTS colaboradores (',
      '  id            TEXT PRIMARY KEY,',
      '  setor         TEXT NOT NULL,',
      '  nome          TEXT NOT NULL,',
      "  situacao      TEXT NOT NULL DEFAULT '',",
      '  hora          REAL NOT NULL DEFAULT 0,',
      '  ordem         INTEGER NOT NULL DEFAULT 0,',
      '  data_cadastro DATETIME NOT NULL',
      ');',
      'CREATE TABLE IF NOT EXISTS eficiencia_dias (',
      '  colaborador_id TEXT NOT NULL,',
      '  setor          TEXT NOT NULL,',
      '  nome           TEXT NOT NULL,',
      "  situacao       TEXT NOT NULL DEFAULT '',",
      '  hora           REAL NOT NULL DEFAULT 0,',
      '  data           TEXT NOT NULL,',
      '  usuario        TEXT,',
      '  ordem          INTEGER NOT NULL DEFAULT 0,',
      '  PRIMARY KEY (colaborador_id, data)',
      ');',
      'CREATE INDEX IF NOT EXISTS ix_efic_data ON eficiencia_dias (data DESC);',
      'CREATE INDEX IF NOT EXISTS ix_efic_setor ON colaboradores (setor);'
    ].join('\n');

    /* bancos criados antes da v1.14 nao tinham a coluna "ordem"
       (a ordem da planilha). Adiciona sem perder nada. */
    function migrarOrdem() {
      ['colaboradores', 'eficiencia_dias'].forEach(function (t) {
        var tem = false;
        try {
          var r = db.exec('PRAGMA table_info(' + t + ')');
          if (r[0]) r[0].values.forEach(function (v) { if (v[1] === 'ordem') tem = true; });
        } catch (e) { return; }
        if (!tem) {
          try { db.run('ALTER TABLE ' + t + ' ADD COLUMN ordem INTEGER NOT NULL DEFAULT 0'); }
          catch (e2) {}
        }
      });
    }

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
            migrarOrdem();
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

    /* ---------- consultas ---------- */
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

    /* =======================================================
       HTML do módulo
    ======================================================= */
    function montarUI() {
      if (montado) return;
      montado = true;
      var main = $('main');

      var wrap = document.createElement('div');
      wrap.innerHTML = [
        /* ---------- ABA 1: FOLHA DO DIA ---------- */
        '<section id="view-' + id + '-dia" class="view" data-modulo="' + id + '">',
        '  <div class="searchbar">',
        '    <input id="' + id + 'Busca" type="search" inputmode="search" placeholder="Buscar colaborador..." autocomplete="off">',
        '    <button id="' + id + 'LimpaBusca" class="icon-btn" type="button" aria-label="Limpar">&times;</button>',
        '  </div>',
        '  <div class="filters">',
        '    <label class="lbl" style="margin:0">Setor</label>',
        '    <select id="' + id + 'Setor" class="sel-setor"></select>',
        '    <button id="' + id + 'Novo2" class="pill" type="button">+ Colaborador</button>',
        '  </div>',
        '  <div class="efic-dia-topo">',
        '    <span id="' + id + 'DataDia" class="efic-data"></span>',
        '    <span id="' + id + 'Resumo" class="muted small"></span>',
        '  </div>',
        '  <div class="efic-head">',
        '    <span>Colaborador</span><span>Situação</span><span>Hora</span>',
        '  </div>',
        '  <div id="' + id + 'Lista" class="list"></div>',
        '  <div class="card">',
        '    <button id="' + id + 'Finalizar" class="btn primary block" type="button">✅ Finalizar eficiência do dia</button>',
        '    <p class="muted small">Guarda a folha de hoje no histórico com a data e limpa tudo para amanhã.</p>',
        '  </div>',
        '</section>',

        /* ---------- ABA 2: HISTÓRICO ---------- */
        '<section id="view-' + id + '-hist" class="view" data-modulo="' + id + '">',
        '  <div class="searchbar">',
        '    <input id="' + id + 'BuscaHist" type="search" placeholder="Filtrar por colaborador, setor..." autocomplete="off">',
        '  </div>',
        '  <div class="filters">',
        '    <label class="lbl" style="margin:0">Dia</label>',
        '    <select id="' + id + 'HistData" class="sel-setor"></select>',
        '  </div>',
        '  <div id="' + id + 'ListaHist" class="list"></div>',
        '  <p class="muted small" style="text-align:center">O histórico guarda os últimos ' + DIAS_HISTORICO + ' dias.</p>',
        '</section>',

        /* ---------- ABA 3: CONFIGURAÇÕES ---------- */
        '<section id="view-' + id + '-cfg" class="view" data-modulo="' + id + '">',
        '  <div class="card">',
        '    <h3>Cadastro de colaborador</h3>',
        '    <button id="' + id + 'Novo" class="btn ghost block" type="button">+ Novo colaborador</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Importar colaboradores (CSV)</h3>',
        '    <p class="muted small">Colunas aceitas: <code>setor;colaborador</code> (ou <code>setor;nome</code>). Separador <code>;</code> ou <code>,</code>.</p>',
        '    <input type="file" id="' + id + 'FileCsv" accept=".csv,.txt" hidden>',
        '    <button id="' + id + 'EscolherCsv" class="btn primary block" type="button">Escolher arquivo CSV</button>',
        '    <div id="' + id + 'CsvResultado" class="muted small"></div>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Banco na nuvem (Supabase)</h3>',
        '    <p class="muted small">Este módulo usa o mesmo banco oficial do app, nas tabelas <code>eficiencia_colaboradores</code> / <code>eficiencia_dias</code> com <code>modulo = "' + id + '"</code>. Não há nada para configurar aqui.</p>',
        '    <div class="kv"><span>Situação</span><b id="' + id + 'NuvemEstado">-</b></div>',
        '    <div class="kv"><span>Servidor</span><b id="' + id + 'NuvemServidor">-</b></div>',
        '    <div class="kv"><span>Aparelho</span><b id="' + id + 'NuvemAparelho">-</b></div>',
        '    <button id="' + id + 'Sync" class="btn primary block" type="button">🔄 Sincronizar agora</button>',
        '    <button id="' + id + 'Enviar" class="btn ghost block" type="button">⬆ Enviar colaboradores deste aparelho</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Excluir colaborador</h3>',
        '    <p class="muted small warn">Apaga o colaborador <b>de vez</b>, junto com todo o histórico dele.</p>',
        '    <input id="' + id + 'ExcluirNome" type="text" placeholder="Nome exato do colaborador" autocomplete="off">',
        '    <input id="' + id + 'ExcluirSetor" type="text" placeholder="Setor" autocomplete="off">',
        '    <button id="' + id + 'Excluir" class="btn danger block" type="button">🗑 Excluir colaborador</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Exportar</h3>',
        '    <p class="muted small">Gera o arquivo para levar ao PC (pasta <em>Downloads</em>).</p>',
        '    <button id="' + id + 'ExportCsv" class="btn primary block" type="button">⬇ Exportar folha de hoje (.csv)</button>',
        '    <button id="' + id + 'ExportCsvHist" class="btn ghost block" type="button">⬇ Exportar histórico (.csv)</button>',
        '    <button id="' + id + 'ExportDb" class="btn ghost block" type="button">⬇ Exportar banco (.db SQLite)</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Este módulo</h3>',
        '    <p class="muted small">Banco local próprio (cache offline), separado dos outros módulos.</p>',
        '    <div class="kv"><span>Colaboradores</span><b id="' + id + 'StatColab">0</b></div>',
        '    <div class="kv"><span>Marcados hoje</span><b id="' + id + 'StatHoje">0</b></div>',
        '    <div class="kv"><span>Dias no histórico</span><b id="' + id + 'StatDias">0</b></div>',
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
        '<button class="tab active" data-view="' + id + '-dia" type="button"><span>👥</span>Eficiência</button>',
        '<button class="tab" data-view="' + id + '-hist" type="button"><span>🕘</span>Histórico</button>',
        '<button class="tab" data-view="' + id + '-cfg" type="button"><span>⚙</span>Configurações</button>'
      ].join('');
      document.body.appendChild(nav);

      /* ---------- sheet de cadastro ---------- */
      var sheets = document.createElement('div');
      sheets.innerHTML = [
        '<div id="' + id + 'SheetCad" class="sheet-wrap" data-modulo="' + id + '">',
        '  <div class="sheet">',
        '    <div class="sheet-handle"></div>',
        '    <h3 id="' + id + 'CadTitulo">Novo colaborador</h3>',
        '    <label class="lbl">Setor *</label>',
        '    <input id="' + id + 'CadSetor" type="text" autocomplete="off" list="' + id + 'Setores">',
        '    <datalist id="' + id + 'Setores"></datalist>',
        '    <label class="lbl">Colaborador *</label>',
        '    <input id="' + id + 'CadNome" type="text" autocomplete="off">',
        '    <div class="sheet-actions">',
        '      <button class="btn ghost" data-' + id + '-fechar="1" type="button">Cancelar</button>',
        '      <button id="' + id + 'CadSalvar" class="btn primary" type="button">Salvar</button>',
        '    </div>',
        '  </div>',
        '</div>'
      ].join('\n');
      while (sheets.firstChild) document.body.appendChild(sheets.firstChild);

      ligarEventos();
    }

    function fecharSheets() {
      $(id + 'SheetCad').classList.remove('open');
    }

    /* =======================================================
       NUVEM
       Igual aos outros módulos: a nuvem é a fonte oficial.
       Sem cofre aberto (sem login), grava só aqui e avisa.
    ======================================================= */
    function nv() {
      if (!(window.Nuvem && Nuvem.ativa())) return null;
      if (!estado.apiNuvem) estado.apiNuvem = Nuvem.eficiencia(id);
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
        db.run('DELETE FROM colaboradores;');
        db.run('DELETE FROM eficiencia_dias;');
        (dados.colaboradores || []).forEach(function (c) {
          db.run(
            'INSERT INTO colaboradores (id,setor,nome,situacao,hora,ordem,data_cadastro) VALUES (?,?,?,?,?,?,?)',
            [c.id, c.setor, c.nome, normSituacao(c.situacao), Number(c.hora) || 0,
             Number(c.ordem) || 0, P.paraLocal(c.data_cadastro)]);
        });
        (dados.dias || []).forEach(function (d) {
          db.run(
            'INSERT INTO eficiencia_dias (colaborador_id,setor,nome,situacao,hora,data,usuario,ordem) VALUES (?,?,?,?,?,?,?,?)',
            [d.colaborador_id, d.setor, d.nome, normSituacao(d.situacao),
             Number(d.hora) || 0, d.data, d.usuario || null, Number(d.ordem) || 0]);
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
      return api.puxarTudo(function (nC, nD) {
        P.nuvemStatus('Baixando... ' + nC + ' colab.' + (nD ? ' / ' + nD + ' dias' : ''), 'sync');
      }).then(function (d) {
        /* trava: nuvem vazia NUNCA apaga o que já existe aqui.
           Nesse caso o certo é usar "Enviar colaboradores". */
        if (!d.colaboradores.length && escalar('SELECT COUNT(*) FROM colaboradores') > 0) {
          statusNuvem();
          if (!silencioso) toast('A nuvem está vazia. Envie os colaboradores deste aparelho primeiro.', 'err');
          return false;
        }
        gravarCache(d);
        statusNuvem();
        render();
        if (!silencioso) toast('Sincronizado · ' + d.colaboradores.length + ' colaboradores', 'ok');
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
      var lista = sel('SELECT id,setor,nome,situacao,hora,ordem FROM colaboradores ORDER BY ordem,setor,nome');
      if (!lista.length) { toast('Nenhum colaborador para enviar', 'err'); return; }
      if (!confirm('Enviar ' + lista.length + ' colaboradores deste aparelho para a nuvem?\n\n' +
                   'Os que já existirem lá NÃO serão duplicados.')) return;
      P.nuvemStatus('Enviando...', 'sync');
      api.enviarColaboradores(lista).then(function () {
        toast('Colaboradores enviados', 'ok');
        return sincronizar(false);
      }).catch(function (e) {
        statusNuvem();
        toast('Falha ao enviar: ' + e.message, 'err');
      });
    }

    /* =======================================================
       MARCAÇÃO (situação / hora) — o coração do módulo
    ======================================================= */
    function aplicarLocal(colabId, situacao, hora) {
      db.run('UPDATE colaboradores SET situacao = ?, hora = ? WHERE id = ?',
        [situacao, hora, colabId]);
      salvar(true);
    }

    function marcar(colabId, situacao, hora, elLinha) {
      situacao = normSituacao(situacao);
      hora = Math.max(0, num(hora));
      var api = nv();

      if (!api) {
        aplicarLocal(colabId, situacao, hora);
        semNuvem();
        atualizarLinha(elLinha, situacao, hora);
        renderResumo();
        return;
      }
      if (elLinha) elLinha.classList.add('gravando');
      api.marcar(colabId, situacao, hora, P.operador()).then(function () {
        aplicarLocal(colabId, situacao, hora);
        atualizarLinha(elLinha, situacao, hora);
        renderResumo();
        statusNuvem();
      }).catch(function (e) {
        statusNuvem();
        P.vibrar([80, 60, 80]);
        toast('NÃO gravado: ' + e.message, 'err');
        /* devolve a tela ao que o banco local tem, para não
           mentir que salvou */
        render();
      }).then(function () {
        if (elLinha) elLinha.classList.remove('gravando');
      });
    }

    function atualizarLinha(el, situacao, hora) {
      if (!el) return;
      el.classList.toggle('falta', situacao === '');
      el.classList.toggle('parcial', situacao === 'P');
      el.classList.toggle('integral', situacao === 'I');
      var h = el.querySelector('[data-' + id + '-hora]');
      if (h && String(num(h.value)) !== String(hora)) h.value = hora ? hora : '';
    }

    /* =======================================================
       FINALIZAR O DIA
    ======================================================= */
    function finalizarDia() {
      var total = escalar('SELECT COUNT(*) FROM colaboradores');
      if (!total) { toast('Não há colaboradores cadastrados', 'err'); return; }

      var dia = hoje();
      var jaTem = escalar('SELECT COUNT(*) FROM eficiencia_dias WHERE data = ?', [dia]);
      var aviso = jaTem
        ? 'O dia ' + dataBR(dia) + ' já foi finalizado antes. Finalizar de novo SUBSTITUI o que está no histórico.\n\n'
        : '';
      var faltas = escalar("SELECT COUNT(*) FROM colaboradores WHERE situacao = ''");

      if (!confirm(aviso + 'Finalizar a eficiência de ' + dataBR(dia) + '?\n\n' +
                   total + ' colaborador(es), sendo ' + faltas + ' marcado(s) como falta.\n' +
                   'A folha vai para o histórico e fica limpa para o próximo dia.')) return;

      var api = nv();
      var btn = $(id + 'Finalizar');
      var rotulo = btn.textContent;

      var localmente = function () {
        var linhas = sel('SELECT id,setor,nome,situacao,hora,ordem FROM colaboradores');
        db.run('BEGIN');
        try {
          db.run('DELETE FROM eficiencia_dias WHERE data = ?', [dia]);
          linhas.forEach(function (c) {
            db.run(
              'INSERT INTO eficiencia_dias (colaborador_id,setor,nome,situacao,hora,data,usuario,ordem) VALUES (?,?,?,?,?,?,?,?)',
              [c.id, c.setor, c.nome, c.situacao, c.hora, dia, P.operador() || null, c.ordem]);
          });
          db.run("UPDATE colaboradores SET situacao = '', hora = 0");
          /* mantém só os últimos DIAS_HISTORICO dias */
          db.run('DELETE FROM eficiencia_dias WHERE data < ?', [limiteHistorico()]);
          db.run('COMMIT');
        } catch (e) {
          try { db.run('ROLLBACK'); } catch (e2) {}
          throw e;
        }
        salvar(true);
        P.vibrar([60, 50, 60]);
        toast('Eficiência de ' + dataBR(dia) + ' finalizada', 'ok');
        estado.histData = dia;
        render();
      };

      if (!api) { localmente(); semNuvem(); return; }

      btn.disabled = true;
      btn.textContent = 'Finalizando na nuvem...';
      /* uma chamada só: o servidor arquiva, limpa e poda o
         histórico na mesma transação, para todos os aparelhos */
      api.finalizar(dia, P.operador()).then(function () {
        return sincronizar(true);
      }).then(function () {
        P.vibrar([60, 50, 60]);
        toast('Eficiência de ' + dataBR(dia) + ' finalizada', 'ok');
        estado.histData = dia;
        render();
      }).catch(function (e) {
        statusNuvem();
        toast('NÃO finalizado: ' + e.message, 'err');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = rotulo;
      });
    }

    /* =======================================================
       CADASTRO / EXCLUSÃO
    ======================================================= */
    function abrirCadastro() {
      $(id + 'CadSetor').value = '';
      $(id + 'CadNome').value = '';
      preencherDatalist();
      $(id + 'SheetCad').classList.add('open');
      setTimeout(function () { $(id + 'CadSetor').focus(); }, 120);
    }

    function salvarCadastro() {
      var setor = $(id + 'CadSetor').value.trim();
      var nome = $(id + 'CadNome').value.trim();
      if (!setor || !nome) { toast('Informe o setor e o colaborador', 'err'); return; }
      var cid = chave(setor, nome);
      if (um('SELECT id FROM colaboradores WHERE id = ?', [cid])) {
        toast('Esse colaborador já existe nesse setor', 'err'); return;
      }

      var ordem = proximaOrdem();
      var localmente = function () {
        db.run("INSERT INTO colaboradores (id,setor,nome,situacao,hora,ordem,data_cadastro) VALUES (?,?,?,'',0,?,?)",
          [cid, setor, nome, ordem, P.agoraISO()]);
        salvar(true);
        fecharSheets();
        toast('Colaborador salvo', 'ok');
        render();
      };

      var api = nv();
      if (!api) { localmente(); semNuvem(); return; }

      var btn = $(id + 'CadSalvar');
      var rotulo = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Gravando na nuvem...';
      api.cadastrar(cid, setor, nome, P.operador(), ordem).then(function () {
        localmente();
      }).catch(function (e) {
        statusNuvem();
        toast('NÃO gravado: ' + e.message, 'err');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = rotulo;
      });
    }

    /* colaborador cadastrado na mao entra no fim da fila */
    function proximaOrdem() {
      return (escalar('SELECT MAX(ordem) FROM colaboradores') || 0) + 1;
    }

    function excluirColaborador() {
      var nome = $(id + 'ExcluirNome').value.trim();
      var setor = $(id + 'ExcluirSetor').value.trim();
      if (!nome || !setor) { toast('Informe o setor e o nome', 'err'); return; }
      var cid = chave(setor, nome);
      var it = um('SELECT * FROM colaboradores WHERE id = ?', [cid]);
      if (!it) { toast('Colaborador não encontrado', 'err'); return; }
      var n = escalar('SELECT COUNT(*) FROM eficiencia_dias WHERE colaborador_id = ?', [cid]);
      if (!confirm('Excluir "' + it.nome + '" (' + it.setor + ') e ' + n + ' dia(s) de histórico?\n\nNão tem como desfazer.')) return;

      var localmente = function () {
        db.run('DELETE FROM eficiencia_dias WHERE colaborador_id = ?', [cid]);
        db.run('DELETE FROM colaboradores WHERE id = ?', [cid]);
        salvar(true);
        $(id + 'ExcluirNome').value = '';
        $(id + 'ExcluirSetor').value = '';
        toast('Colaborador excluído', 'ok');
        render();
      };

      var api = nv();
      if (!api) { localmente(); semNuvem(); return; }
      api.excluir(cid, P.operador()).then(function () { localmente(); })
        .catch(function (e) { statusNuvem(); toast('NÃO excluído: ' + e.message, 'err'); });
    }

    /* ---------- importação CSV ---------- */
    function importarCsv(texto) {
      var d = lerCsv(texto);
      var iSetor = -1, iNome = -1;
      d.cabecalho.forEach(function (h, i) {
        if (iSetor < 0 && (h === 'setor' || h === 'sector' || h === 'area')) iSetor = i;
        if (iNome < 0 && (h === 'colaborador' || h === 'nome' || h === 'funcionario' || h === 'name')) iNome = i;
      });
      if (iSetor < 0 || iNome < 0) {
        $(id + 'CsvResultado').textContent = 'CSV sem as colunas "setor" e "colaborador".';
        return;
      }

      var lista = [], vistos = {}, pulados = 0;
      d.linhas.forEach(function (l) {
        var setor = (l[iSetor] || '').trim();
        var nome = (l[iNome] || '').trim();
        if (!setor || !nome) { pulados++; return; }
        var cid = chave(setor, nome);
        if (vistos[cid]) { pulados++; return; }
        vistos[cid] = 1;
        /* a posicao da linha no arquivo E a ordem oficial */
        lista.push({ id: cid, setor: setor, nome: nome, ordem: lista.length + 1 });
      });
      if (!lista.length) {
        $(id + 'CsvResultado').textContent = 'Nenhuma linha válida no arquivo.';
        return;
      }

      var localmente = function () {
        var novos = 0, existentes = 0;
        lista.forEach(function (c) {
          if (um('SELECT id FROM colaboradores WHERE id = ?', [c.id])) {
            /* ja existe: so acerta setor/nome e a ORDEM da planilha.
               A marcacao do dia (situacao/hora) nao e tocada. */
            db.run('UPDATE colaboradores SET setor = ?, nome = ?, ordem = ? WHERE id = ?',
              [c.setor, c.nome, c.ordem, c.id]);
            existentes++;
            return;
          }
          db.run("INSERT INTO colaboradores (id,setor,nome,situacao,hora,ordem,data_cadastro) VALUES (?,?,?,'',0,?,?)",
            [c.id, c.setor, c.nome, c.ordem, P.agoraISO()]);
          novos++;
        });
        salvar(true);
        $(id + 'CsvResultado').textContent =
          novos + ' novo(s), ' + existentes + ' já existia(m) (ordem atualizada)' +
          (pulados ? ', ' + pulados + ' linha(s) ignorada(s)' : '') + '.';
        toast('Importação concluída', 'ok');
        render();
      };

      var api = nv();
      if (!api) { localmente(); $(id + 'CsvResultado').textContent += ' — só neste aparelho (sem nuvem).'; return; }

      $(id + 'CsvResultado').textContent = 'Enviando ' + lista.length + ' linha(s) para a nuvem...';
      P.nuvemStatus('Enviando...', 'sync');
      api.enviarColaboradores(lista).then(function () {
        $(id + 'CsvResultado').textContent =
          lista.length + ' linha(s) enviada(s)' + (pulados ? ', ' + pulados + ' ignorada(s)' : '') + '.';
        toast('Importação concluída', 'ok');
        return sincronizar(true);
      }).catch(function (e) {
        statusNuvem();
        $(id + 'CsvResultado').textContent = 'Falha ao enviar: ' + e.message;
        toast('NÃO importado: ' + e.message, 'err');
      });
    }

    /* =======================================================
       RENDERIZAÇÃO
    ======================================================= */
    /* a ordem dos setores e a ordem em que eles aparecem na
       planilha: manda o menor "ordem" dos colaboradores dele */
    function setores() {
      return sel('SELECT setor, MIN(ordem) AS mo FROM colaboradores ' +
                 'GROUP BY setor ORDER BY mo, setor')
        .map(function (r) { return r.setor; });
    }

    function preencherDatalist() {
      var dl = $(id + 'Setores');
      if (dl) dl.innerHTML = setores().map(function (s) {
        return '<option value="' + esc(s) + '">';
      }).join('');
    }

    function preencherSetores() {
      var s = $(id + 'Setor');
      if (!s) return;
      var atual = estado.setor;
      var lista = setores();
      s.innerHTML = ['<option value="TODOS">Todos os setores</option>']
        .concat(lista.map(function (x) {
          return '<option value="' + esc(x) + '">' + esc(x) + '</option>';
        })).join('');
      /* se o setor filtrado sumiu (colaborador excluído), volta para Todos */
      if (atual !== 'TODOS' && lista.indexOf(atual) < 0) estado.setor = 'TODOS';
      s.value = estado.setor;
    }

    function linhasDoDia() {
      /* ordem = a da planilha importada: setores na ordem em que
         apareceram e, dentro do setor, linha por linha */
      var sql = 'SELECT c.* FROM colaboradores c ' +
                'JOIN (SELECT setor, MIN(ordem) AS mo FROM colaboradores GROUP BY setor) s ' +
                '  ON s.setor = c.setor';
      var cond = [], par = [];
      if (estado.setor !== 'TODOS') { cond.push('c.setor = ?'); par.push(estado.setor); }
      if (estado.busca) {
        cond.push('(LOWER(c.nome) LIKE ? OR LOWER(c.setor) LIKE ?)');
        par.push('%' + estado.busca + '%', '%' + estado.busca + '%');
      }
      if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
      sql += ' ORDER BY s.mo, c.setor, c.ordem, c.nome';
      return sel(sql, par);
    }

    function opcoesSituacao(atual) {
      return SITUACOES.map(function (s) {
        return '<option value="' + s.cod + '"' + (s.cod === (atual || '') ? ' selected' : '') + '>' +
               esc(s.label) + '</option>';
      }).join('');
    }

    function renderLista() {
      $(id + 'DataDia').textContent = 'Folha de ' + dataBR(hoje());
      preencherSetores();
      preencherDatalist();

      var linhas = linhasDoDia();
      var el = $(id + 'Lista');
      if (!linhas.length) {
        var temAlgum = escalar('SELECT COUNT(*) FROM colaboradores');
        el.innerHTML = temAlgum
          ? '<div class="vazio">Nenhum colaborador nesse filtro.</div>'
          : '<div class="vazio">Nenhum colaborador cadastrado ainda.<br>' +
            'O cadastro é fixo: você monta a equipe uma vez e depois só marca<br>' +
            'falta e hora todo dia.<br><br>' +
            '<button id="' + id + 'NovoVazio" class="btn primary" type="button">+ Cadastrar colaborador</button>' +
            '</div>';
        if (!temAlgum) {
          var b = $(id + 'NovoVazio');
          if (b) b.addEventListener('click', abrirCadastro);
        }
        renderResumo();
        return;
      }

      var setorAtual = null;
      var html = [];
      linhas.forEach(function (c) {
        /* cabeçalho de setor só aparece quando estamos vendo tudo */
        if (estado.setor === 'TODOS' && c.setor !== setorAtual) {
          setorAtual = c.setor;
          html.push('<div class="efic-setor">' + esc(c.setor) + '</div>');
        }
        var cls = c.situacao === 'I' ? 'integral' : (c.situacao === 'P' ? 'parcial' : 'falta');
        html.push(
          '<div class="efic-linha ' + cls + '" data-' + id + '-linha="' + esc(c.id) + '">' +
            '<div class="efic-nome">' + esc(c.nome) + '</div>' +
            '<select class="efic-sit" data-' + id + '-sit="' + esc(c.id) + '" aria-label="Situação de ' + esc(c.nome) + '">' +
              opcoesSituacao(c.situacao) +
            '</select>' +
            '<input class="efic-hora" type="number" inputmode="decimal" step="any" min="0" ' +
              'placeholder="0" value="' + (Number(c.hora) ? c.hora : '') + '" ' +
              'data-' + id + '-hora="' + esc(c.id) + '" aria-label="Horas de ' + esc(c.nome) + '">' +
          '</div>');
      });
      el.innerHTML = html.join('');
      renderResumo();
    }

    function renderResumo() {
      var total = escalar('SELECT COUNT(*) FROM colaboradores');
      var i = escalar("SELECT COUNT(*) FROM colaboradores WHERE situacao = 'I'");
      var p = escalar("SELECT COUNT(*) FROM colaboradores WHERE situacao = 'P'");
      var f = escalar("SELECT COUNT(*) FROM colaboradores WHERE situacao = ''");
      var h = escalar('SELECT IFNULL(SUM(hora),0) FROM colaboradores');
      var el = $(id + 'Resumo');
      if (el) {
        el.textContent = total + ' colab. · ' + i + ' I · ' + p + ' P · ' + f + ' falta(s) · ' +
                         P.fmtNum(h) + ' h';
      }
    }

    function preencherDatasHist() {
      var s = $(id + 'HistData');
      if (!s) return;
      var dias = sel('SELECT DISTINCT data FROM eficiencia_dias ORDER BY data DESC')
        .map(function (r) { return r.data; });
      s.innerHTML = ['<option value="TODAS">Todos os dias</option>']
        .concat(dias.map(function (d) {
          return '<option value="' + d + '">' + dataBR(d) + '</option>';
        })).join('');
      if (estado.histData !== 'TODAS' && dias.indexOf(estado.histData) < 0) estado.histData = 'TODAS';
      s.value = estado.histData;
    }

    function renderHist() {
      preencherDatasHist();
      var termo = ($(id + 'BuscaHist').value || '').trim().toLowerCase();
      var sql = 'SELECT * FROM eficiencia_dias';
      var cond = [], par = [];
      if (estado.histData !== 'TODAS') { cond.push('data = ?'); par.push(estado.histData); }
      if (termo) {
        cond.push('(LOWER(nome) LIKE ? OR LOWER(setor) LIKE ?)');
        par.push('%' + termo + '%', '%' + termo + '%');
      }
      if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
      sql += ' ORDER BY data DESC, ordem, setor, nome LIMIT 800';

      var linhas = sel(sql, par);
      var el = $(id + 'ListaHist');
      if (!linhas.length) {
        el.innerHTML = '<div class="vazio">Nenhum dia finalizado ainda.<br>' +
          'O histórico aparece depois que você clicar em "Finalizar eficiência do dia".</div>';
        return;
      }

      var dataAtual = null;
      var html = [];
      linhas.forEach(function (r) {
        if (r.data !== dataAtual) {
          dataAtual = r.data;
          html.push('<div class="efic-setor">' + dataBR(r.data) + '</div>');
        }
        var cls = r.situacao === 'I' ? 'integral' : (r.situacao === 'P' ? 'parcial' : 'falta');
        html.push(
          '<div class="li">' +
            '<div class="li-main">' +
              '<span class="li-nome">' + esc(r.nome) + '</span>' +
              '<span class="li-sub">' + esc(r.setor) +
                (r.usuario ? ' · ' + esc(r.usuario) : '') + '</span>' +
            '</div>' +
            '<div class="li-saldo-txt">' +
              '<span class="badge ' + cls + '">' + esc(r.situacao || 'Falta') + '</span>' +
              '<small class="muted">' + (Number(r.hora) ? P.fmtNum(r.hora) + ' h' : '-') + '</small>' +
            '</div>' +
          '</div>');
      });
      el.innerHTML = html.join('');
    }

    function renderStats() {
      $(id + 'StatColab').textContent = escalar('SELECT COUNT(*) FROM colaboradores');
      $(id + 'StatHoje').textContent =
        escalar("SELECT COUNT(*) FROM colaboradores WHERE situacao <> '' OR hora > 0");
      $(id + 'StatDias').textContent =
        escalar('SELECT COUNT(DISTINCT data) FROM eficiencia_dias');
      $(id + 'StatSalvo').textContent =
        P.fmtDataHora(localStorage.getItem('ultimo_salvamento_' + id) || '') || '-';
    }

    function render() {
      renderLista();
      renderHist();
      renderStats();
    }

    /* =======================================================
       EVENTOS
    ======================================================= */
    function ligarEventos() {
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
      $(id + 'Setor').addEventListener('change', function () {
        estado.setor = this.value;
        renderLista();
      });

      /* marcação: delegado, porque as linhas são recriadas */
      var lista = $(id + 'Lista');
      lista.addEventListener('change', function (ev) {
        var alvo = ev.target;
        var cid = alvo.getAttribute('data-' + id + '-sit') || alvo.getAttribute('data-' + id + '-hora');
        if (!cid) return;
        var linha = alvo.closest('[data-' + id + '-linha]');
        var sit = linha.querySelector('[data-' + id + '-sit]').value;
        var hora = linha.querySelector('[data-' + id + '-hora]').value;
        marcar(cid, sit, hora, linha);
      });

      $(id + 'Finalizar').addEventListener('click', finalizarDia);

      /* histórico */
      var tHist = null;
      $(id + 'BuscaHist').addEventListener('input', function () {
        clearTimeout(tHist);
        tHist = setTimeout(renderHist, 180);
      });
      $(id + 'HistData').addEventListener('change', function () {
        estado.histData = this.value;
        renderHist();
      });

      /* cadastro */
      $(id + 'Novo').addEventListener('click', abrirCadastro);
      $(id + 'Novo2').addEventListener('click', abrirCadastro);
      $(id + 'CadSalvar').addEventListener('click', salvarCadastro);
      qsa('[data-' + id + '-fechar]').forEach(function (b) {
        b.addEventListener('click', fecharSheets);
      });

      /* configurações */
      $(id + 'Sync').addEventListener('click', function () { sincronizar(false); });
      $(id + 'Enviar').addEventListener('click', enviarDaqui);
      $(id + 'Excluir').addEventListener('click', excluirColaborador);
      $(id + 'Apagar').addEventListener('click', apagarTudo);

      $(id + 'EscolherCsv').addEventListener('click', function () { $(id + 'FileCsv').click(); });
      $(id + 'FileCsv').addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        P.lerTexto(f, function (txt) { importarCsv(txt); });
        ev.target.value = '';
      });

      $(id + 'ExportCsv').addEventListener('click', function () {
        var cols = ['setor', 'colaborador', 'situacao', 'hora'];
        var txt = P.csvDe(cols,
          sel('SELECT setor, nome AS colaborador, situacao, hora' +
              ' FROM colaboradores ORDER BY setor, nome'));
        P.baixar(new Blob([txt], { type: 'text/csv;charset=utf-8' }),
          id + '_folha_' + hoje() + '.csv');
        toast('CSV gerado (pasta Downloads)', 'ok');
      });
      $(id + 'ExportCsvHist').addEventListener('click', function () {
        var cols = ['data', 'setor', 'colaborador', 'situacao', 'hora', 'usuario'];
        var txt = P.csvDe(cols,
          sel('SELECT data, setor, nome AS colaborador, situacao, hora, usuario' +
              ' FROM eficiencia_dias ORDER BY data DESC, setor, nome'));
        P.baixar(new Blob([txt], { type: 'text/csv;charset=utf-8' }),
          id + '_historico_' + P.carimbo() + '.csv');
        toast('CSV gerado (pasta Downloads)', 'ok');
      });
      $(id + 'ExportDb').addEventListener('click', function () {
        try {
          P.baixar(new Blob([db.export()], { type: 'application/x-sqlite3' }),
            id + '_' + P.carimbo() + '.db');
          toast('Arquivo .db gerado (pasta Downloads)', 'ok');
        } catch (e) { toast('Erro ao exportar: ' + e.message, 'err'); }
      });

      /* abas do módulo */
      qsa('#tabbar-' + id + ' .tab').forEach(function (t) {
        t.addEventListener('click', function () { P.mostrarView(t.dataset.view); });
      });
    }

    function apagarTudo() {
      if (!confirm('Limpar a cópia local de "' + cfg.nome + '" NESTE APARELHO?\n\n' +
                   'Nada é apagado da nuvem: ao sincronizar, tudo volta.\n' +
                   'Serve para resolver bagunça no cache.')) return;
      if (!confirm('Última confirmação: limpar a cópia local deste módulo?')) return;
      db.run('DELETE FROM eficiencia_dias; DELETE FROM colaboradores;');
      salvar(true);
      toast('Cópia local apagada', 'ok');
      render();
    }

    /* ---------- API da instância ---------- */
    return {
      cfg: cfg,
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
        if (!montado) return;
        if (nome === id + '-dia') renderLista();
        else if (nome === id + '-hist') renderHist();
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
