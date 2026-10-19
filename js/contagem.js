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

  /* camada compartilhada - ver js/base.js */
  var idbOpen = window.PCPDB.open, idbSet = window.PCPDB.set, idbGet = window.PCPDB.get;
  var num = window.PCPDB.num, lerCsv = window.PCPDB.lerCsv;



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
    /* combinacoes (cor do quadro + cor da articulacao): so Maquinas VG.
       Tabelas locais: CMB (qtd por combinacao) e OPC (opcoes dos dropdowns).
       Na nuvem: contagem_combos / contagem_cores_opcoes. */
    var COMBOS = !!cfg.combos;
    var CMB = 'cmb_' + id, OPC = 'opc_' + id;
    /* foto de referência no item: por enquanto só Carenagens VG.
       Fica no IndexedDB local (kv: foto_<codigo>), fora do SQLite,
       porque a sincronização apaga e regrava a tabela de itens. */
    var TEM_FOTO = (id === 'carenagem');
    /* contagem por cor: só Carenagens VG. A qtd do item passa a ser a soma
       dos tipos abaixo, gravados em uma coluna por tipo (local e na nuvem). */
    var TEM_CORES = (id === 'carenagem');
    var CORES = [
      { col: 'qtd_onix', nome: 'Ônix' },
      { col: 'qtd_preto_fosco', nome: 'Preto fosco' },
      { col: 'qtd_black_piano', nome: 'Black piano' },
      { col: 'qtd_cinza', nome: 'Cinza' },
      { col: 'qtd_champanhe', nome: 'Champanhe' },
      { col: 'qtd_3d', nome: 'Adesivada 3D' }
    ];

    var db = null, saveTimer = null, montado = false, promessa = null;
    var estado = { busca: '', movFiltro: 'TODOS', itemAtual: null, editando: false };

    var SCHEMA = [
      'CREATE TABLE IF NOT EXISTS ' + TAB + ' (',
      '  codigo TEXT PRIMARY KEY,',
      '  nome TEXT NOT NULL,',
      '  qtd REAL NOT NULL DEFAULT 0,',
      (TEM_CORES ? CORES.map(function (c) {
        return '  ' + c.col + ' REAL NOT NULL DEFAULT 0,';
      }).join('\n') : ''),
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
      '  observacao TEXT' + (TEM_CORES ? ', cores TEXT' : ''),
      ');',
      'CREATE INDEX IF NOT EXISTS ix_' + id + '_mov_item ON ' + MOV + '(codigo_item);',
      'CREATE INDEX IF NOT EXISTS ix_' + id + '_mov_data ON ' + MOV + '(data_hora);',
      (COMBOS ? [
        'CREATE TABLE IF NOT EXISTS ' + CMB + ' (',
        '  codigo TEXT NOT NULL, cor_quadro TEXT NOT NULL, cor_articulacao TEXT NOT NULL,',
        '  qtd REAL NOT NULL DEFAULT 0,',
        '  PRIMARY KEY (codigo, cor_quadro, cor_articulacao)',
        ');',
        'CREATE TABLE IF NOT EXISTS ' + OPC + ' (',
        '  tipo TEXT NOT NULL, nome TEXT NOT NULL, PRIMARY KEY (tipo, nome)',
        ');'
      ].join('\n') : '')
    ].join('\n');

    /* ---------- banco (kit compartilhado) ---------- */
    var K = window.PCPDB.kit({ idb: IDB, id: id, schema: SCHEMA });

    function abrirBanco() {
      return K.abrir().then(function () {
        db = K.db;
        if (!TEM_CORES) return;
        /* banco local antigo: acrescenta as colunas de cor que faltarem */
        var tem = {};
        K.sel('PRAGMA table_info(' + TAB + ')').forEach(function (c) { tem[c.name] = true; });
        var faltou = false;
        CORES.forEach(function (c) {
          if (tem[c.col]) return;
          db.run('ALTER TABLE ' + TAB + ' ADD COLUMN ' + c.col + ' REAL NOT NULL DEFAULT 0');
          faltou = true;
        });
        /* histórico antigo: coluna com as cores de cada movimentação (JSON) */
        var temMov = {};
        K.sel('PRAGMA table_info(' + MOV + ')').forEach(function (c) { temMov[c.name] = true; });
        if (!temMov.cores) {
          db.run('ALTER TABLE ' + MOV + ' ADD COLUMN cores TEXT');
          faltou = true;
        }
        if (faltou) salvar(true);
      });
    }

    var salvar = K.salvar, sel = K.sel, um = K.um, escalar = K.escalar;

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

    /* colunas de cor: lista para SQL e valores de um registro */
    var COLS_COR = TEM_CORES ? CORES.map(function (c) { return c.col; }) : [];
    var SQL_COR = COLS_COR.length ? ',' + COLS_COR.join(',') : '';
    var PH_COR = COLS_COR.map(function () { return ',?'; }).join('');
    function coresDe(o) {
      return COLS_COR.map(function (c) { return Number(o && o[c]) || 0; });
    }
    /* ex.: "1 Preto fosco ; 2 Ônix" - só as cores diferentes de zero */
    function textoCores(o) {
      if (!TEM_CORES || !o) return '';
      return CORES.filter(function (c) { return (Number(o[c.col]) || 0) > 0; })
        .map(function (c) { return P.fmtNum(Number(o[c.col])) + ' ' + c.nome; }).join(' ; ');
    }
    /* cores da movimentação: vem da nuvem como objeto, do SQLite como texto */
    function coresMov(v) {
      if (!v) return null;
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch (e) { return null; }
    }

    /* substitui o cache local pelo conteúdo da nuvem */
    function gravarCache(dados) {
      db.run('BEGIN');
      try {
        db.run('DELETE FROM ' + MOV);
        db.run('DELETE FROM ' + TAB);
        dados.itens.forEach(function (it) {
          db.run('INSERT INTO ' + TAB + ' (codigo,nome,qtd,data_cadastro' + SQL_COR +
            ') VALUES (?,?,?,?' + PH_COR + ')',
            [it.codigo, it.nome, Number(it.qtd) || 0, P.paraLocal(it.data_cadastro)]
              .concat(coresDe(it)));
        });
        dados.movimentacoes.forEach(function (m) {
          var cm = coresMov(m.cores);
          db.run('INSERT INTO ' + MOV +
            ' (id,codigo_item,tipo,quantidade,qtd_final,data_hora,usuario,observacao' +
            (TEM_CORES ? ',cores' : '') + ') VALUES (?,?,?,?,?,?,?,?' + (TEM_CORES ? ',?' : '') + ')',
            [m.id, m.codigo_item, m.tipo, Number(m.quantidade) || 0,
             m.qtd_final == null ? null : Number(m.qtd_final),
             P.paraLocal(m.data_hora), m.usuario || null, m.observacao || null]
              .concat(TEM_CORES ? [cm ? JSON.stringify(cm) : null] : []));
        });
        if (COMBOS && dados.combos) {
          db.run('DELETE FROM ' + CMB);
          dados.combos.forEach(function (c) {
            db.run('INSERT INTO ' + CMB + ' (codigo,cor_quadro,cor_articulacao,qtd) VALUES (?,?,?,?)',
              [c.codigo, c.cor_quadro, c.cor_articulacao, Number(c.qtd) || 0]);
          });
        }
        if (COMBOS && dados.opcoes) {
          db.run('DELETE FROM ' + OPC);
          dados.opcoes.forEach(function (o) {
            db.run('INSERT OR IGNORE INTO ' + OPC + ' (tipo,nome) VALUES (?,?)', [o.tipo, o.nome]);
          });
        }
        db.run('COMMIT');
      } catch (e) {
        try { db.run('ROLLBACK'); } catch (e2) {}
        throw e;
      }
      salvar(true);
    }

    /* baixa combinacoes e opcoes junto com os itens (so modulos com combos) */
    function carregarExtras(d) {
      if (!COMBOS) return Promise.resolve(d);
      var api = nv();
      return Promise.all([api.puxarCombos(), api.puxarOpcoes()]).then(function (r) {
        d.combos = r[0] || [];
        d.opcoes = r[1] || [];
        return d;
      }).catch(function () { return d; });  /* patch SQL ainda nao rodou: segue sem combos */
    }

    /* aplica no cache o item devolvido pela nuvem */
    function itemDaResposta(r) {
      if (!r) return null;
      return Array.isArray(r) ? (r[0] || null) : r;
    }
    function upsertLocal(it) {
      if (!it) return;
      if (um('SELECT codigo FROM ' + TAB + ' WHERE codigo = ?', [it.codigo])) {
        db.run('UPDATE ' + TAB + ' SET nome = ?, qtd = ?' +
          COLS_COR.map(function (c) { return ', ' + c + ' = ?'; }).join('') +
          ' WHERE codigo = ?',
          [it.nome, Number(it.qtd) || 0].concat(coresDe(it), [it.codigo]));
      } else {
        db.run('INSERT INTO ' + TAB + ' (codigo,nome,qtd,data_cadastro' + SQL_COR +
          ') VALUES (?,?,?,?' + PH_COR + ')',
          [it.codigo, it.nome, Number(it.qtd) || 0, P.paraLocal(it.data_cadastro)]
            .concat(coresDe(it)));
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
      }).then(carregarExtras).then(function (d) {
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
        if (COMBOS) renderOpcoes();
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
        (COMBOS ? [
          '    <div class="card">',
          '      <h3>Cores (dropdowns)</h3>',
          '      <p class="muted small">Lista usada ao contar: cor do quadro e cor da articulação.</p>',
          '      <select id="' + id + 'OpcTipo" class="inp"><option value="quadro">Cor do quadro</option><option value="articulacao">Cor da articulação</option></select>',
          '      <input id="' + id + 'OpcNome" type="text" class="inp" placeholder="Nova cor" autocomplete="off">',
          '      <button id="' + id + 'OpcAdd" class="btn ghost block" type="button">+ Adicionar cor</button>',
          '      <div id="' + id + 'OpcLista"></div>',
          '    </div>'
        ].join('\n') : ''),
        '    <button id="' + id + 'Relatorio" class="btn primary block" type="button">📋 Relatório de contagem (.csv)</button>',
        '    <p class="muted small">Cod, Nome e Qtd. Itens zerados não entram.</p>',
        '    <button id="' + id + 'ExportCsv" class="btn ghost block" type="button">⬇ Exportar itens (.csv)</button>',
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
        TEM_FOTO ? [
          '    <div class="foto-box">',
          '      <img id="' + id + 'FotoImg" class="foto-thumb hidden" alt="Foto de referência">',
          '      <p id="' + id + 'FotoVazio" class="muted small">Sem foto de referência.</p>',
          '      <input id="' + id + 'FotoFile" type="file" accept="image/*" hidden>',
          '      <div class="foto-acts">',
          '        <button id="' + id + 'FotoAdd" class="btn ghost" type="button">📷 Foto</button>',
          '        <button id="' + id + 'FotoDel" class="btn ghost hidden" type="button">🗑️ Remover foto</button>',
          '      </div>',
          '    </div>'
        ].join('\n') : '',
        TEM_CORES ? [
          '    <label class="lbl">Quantidade contada por cor</label>'
        ].concat(CORES.map(function (c) {
          return [
            '    <div class="mov-item">',
            '      <b>' + c.nome + '</b>',
            '      <div class="qty">',
            '        <button class="qty-btn" data-' + id + 'cor="' + c.col + '" data-' + id + 'corpasso="-1" type="button">-</button>',
            '        <input id="' + id + 'Cor_' + c.col + '" class="' + id + '-cor" type="number" inputmode="decimal" step="any" min="0" value="0">',
            '        <button class="qty-btn" data-' + id + 'cor="' + c.col + '" data-' + id + 'corpasso="1" type="button">+</button>',
            '      </div>',
            '    </div>'
          ].join('\n');
        })).concat([
          '    <input id="' + id + 'QtdInput" type="number" value="0" hidden>'
        ]).join('\n') : [
          (COMBOS ? [
            '    <div style="display:flex;gap:10px">',
            '      <div style="flex:1;min-width:0"><label class="lbl">Cor do quadro</label>',
            '      <select id="' + id + 'CmbQ" class="inp"></select></div>',
            '      <div style="flex:1;min-width:0"><label class="lbl">Cor da articulação</label>',
            '      <select id="' + id + 'CmbA" class="inp"></select></div>',
            '    </div>'
          ].join('\n') + '\n' : '') +
          '    <label class="lbl">Quantidade contada' + (COMBOS ? ' (desta combinação)' : '') + '</label>',
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
          '    </div>'
        ].join('\n'),
        '    <label class="lbl">Observação (opcional)</label>',
        '    <input id="' + id + 'QtdObs" type="text" placeholder="Ex.: contagem do turno, sobra de linha...">',
        '    <div id="' + id + 'QtdPrevia" class="previa"></div>',
        '    <div class="sheet-actions">',
        '      <button class="btn ghost" data-' + id + 'fechar="1" type="button">Cancelar</button>',
        '      <button id="' + id + 'QtdSalvar" class="btn primary" type="button">Confirmar</button>',
        '    </div>',
        (COMBOS ? [
          '    <label class="lbl">Já contadas nesta máquina</label>',
          '    <div id="' + id + 'CmbContadas"></div>'
        ].join('\n') : ''),
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
        TEM_FOTO ? [
          '    <label class="lbl">Foto de referência</label>',
          '    <div class="foto-box">',
          '      <img id="' + id + 'CadFotoImg" class="foto-thumb hidden" alt="Foto de referência">',
          '      <p id="' + id + 'CadFotoVazio" class="muted small">Sem foto de referência.</p>',
          '      <input id="' + id + 'CadFotoFile" type="file" accept="image/*" hidden>',
          '      <div class="foto-acts">',
          '        <button id="' + id + 'CadFotoAdd" class="btn ghost" type="button">📷 Foto</button>',
          '        <button id="' + id + 'CadFotoDel" class="btn ghost hidden" type="button">🗑 Remover foto</button>',
          '      </div>',
          '    </div>'
        ].join('\n') : '',
        '    <div class="sheet-actions">',
        '      <button class="btn ghost" data-' + id + 'fechar="1" type="button">Cancelar</button>',
        '      <button id="' + id + 'CadSalvar" class="btn primary" type="button">Salvar</button>',
        '    </div>',
        '  </div>',
        '</div>',
        TEM_FOTO ? [
          '<div id="' + id + 'Visor" class="visor hidden">',
          '  <div class="visor-bar">',
          '    <button id="' + id + 'VisorSair" class="btn ghost" type="button">← Voltar</button>',
          '    <span id="' + id + 'VisorNome" class="muted small"></span>',
          '  </div>',
          '  <div id="' + id + 'VisorPalco" class="visor-palco">',
          '    <img id="' + id + 'VisorImg" alt="Foto de referência">',
          '  </div>',
          '</div>'
        ].join('\n') : ''
      ].join('\n');
      while (sheets.firstChild) document.body.appendChild(sheets.firstChild);

      ligarEventos();
    }

    /* ---------- sheets: abrir/fechar ---------- */
    function fecharSheets() {
      $(id + 'SheetQtd').classList.remove('open');
      $(id + 'SheetCad').classList.remove('open');
    }

    /* ---------- foto de referência (só TEM_FOTO) ---------- */
    var fotoAtual = null;

    function mostrarFoto(dataUrl) {
      fotoAtual = dataUrl || null;
      var img = $(id + 'FotoImg');
      img.classList.toggle('hidden', !fotoAtual);
      if (fotoAtual) img.src = fotoAtual;
      $(id + 'FotoVazio').classList.toggle('hidden', !!fotoAtual);
      $(id + 'FotoDel').classList.toggle('hidden', !fotoAtual);
      $(id + 'FotoAdd').textContent = fotoAtual ? '📷 Trocar foto' : '📷 Foto';
    }

    /* a foto oficial mora na nuvem (contagem_fotos), igual para todo mundo.
       O IndexedDB local é só cache, para abrir rápido e funcionar offline. */
    function ainda(codigo) {
      return estado.itemAtual && estado.itemAtual.codigo === codigo;
    }

    function carregarFoto(codigo) {
      mostrarFoto(null);
      idbGet(IDB, 'foto_' + codigo).then(function (v) {
        if (v && ainda(codigo)) mostrarFoto(v);
      }).catch(function () {});

      var api = nv();
      if (!api) return;
      api.puxarFoto(codigo).then(function (url) {
        if (ainda(codigo)) mostrarFoto(url);
        return idbSet(IDB, 'foto_' + codigo, url || null);
      }).catch(function () {});   // offline: fica o cache
    }

    /* reduz a imagem antes de guardar: celular tira foto de 4 MB */
    function comprimir(file, aoPronto) {
      var fr = new FileReader();
      fr.onload = function () {
        var im = new Image();
        im.onload = function () {
          var MAX = 1000;   /* vai para o banco em base64: segura o tamanho */
          var e = Math.min(1, MAX / Math.max(im.width, im.height));
          var cv = document.createElement('canvas');
          cv.width = Math.round(im.width * e);
          cv.height = Math.round(im.height * e);
          cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
          aoPronto(cv.toDataURL('image/jpeg', 0.72));
        };
        im.onerror = function () { toast('Imagem inválida', 'err'); };
        im.src = fr.result;
      };
      fr.onerror = function () { toast('Erro ao ler a imagem', 'err'); };
      fr.readAsDataURL(file);
    }

    function salvarFoto(file) {
      var it = estado.itemAtual;
      if (!it) return;
      var api = nv();
      if (!api) { toast('Sem nuvem: entre online para salvar a foto', 'err'); return; }

      comprimir(file, function (url) {
        if (ainda(it.codigo)) mostrarFoto(url);
        var b = $(id + 'FotoAdd');
        var rotulo = b.textContent;
        b.disabled = true; b.textContent = 'Enviando foto...';
        api.salvarFoto(it.codigo, url, P.operador() || null).then(function () {
          toast('Foto salva para todos', 'ok');
          return idbSet(IDB, 'foto_' + it.codigo, url);
        }).catch(function (e) {
          toast('Erro ao enviar foto: ' + e.message, 'err');
          if (ainda(it.codigo)) carregarFoto(it.codigo);
        }).then(function () {
          b.disabled = false;
          if (b.textContent === 'Enviando foto...') b.textContent = rotulo;
        });
      });
    }

    function removerFoto() {
      var it = estado.itemAtual;
      if (!it || !confirm('Remover a foto deste item? Ela sai para todo mundo.')) return;
      var api = nv();
      if (!api) { toast('Sem nuvem: entre online para remover a foto', 'err'); return; }

      api.apagarFoto(it.codigo).then(function () {
        if (ainda(it.codigo)) mostrarFoto(null);
        toast('Foto removida', 'ok');
        return idbSet(IDB, 'foto_' + it.codigo, null);
      }).catch(function (e) { toast('Erro ao remover foto: ' + e.message, 'err'); });
    }

    /* ---------- visor em tela cheia (zoom + arrastar) ---------- */
    var vz = { esc: 1, x: 0, y: 0, d0: 0, e0: 1, px: 0, py: 0, arrastando: false };

    function aplicarZoom() {
      $(id + 'VisorImg').style.transform =
        'translate(' + vz.x + 'px,' + vz.y + 'px) scale(' + vz.esc + ')';
    }

    function abrirVisor() {
      if (!fotoAtual) return;
      vz.esc = 1; vz.x = 0; vz.y = 0;
      $(id + 'VisorImg').src = fotoAtual;
      $(id + 'VisorNome').textContent = estado.itemAtual
        ? estado.itemAtual.codigo + ' — ' + estado.itemAtual.nome : '';
      aplicarZoom();
      $(id + 'Visor').classList.remove('hidden');
    }

    function fecharVisor() { $(id + 'Visor').classList.add('hidden'); }
    function visorAberto() { return TEM_FOTO && !$(id + 'Visor').classList.contains('hidden'); }

    function abrirQtd(codigo) {
      var it = um('SELECT * FROM ' + TAB + ' WHERE codigo = ?', [codigo]);
      if (!it) { toast('Item não encontrado', 'err'); return; }
      estado.itemAtual = it;
      $(id + 'QtdNome').textContent = it.codigo + ' — ' + it.nome;
      $(id + 'QtdAtual').textContent = 'Qtd atual: ' + P.fmtNum(it.qtd) + ' ' + UN;
      $(id + 'QtdInput').value = it.qtd;
      $(id + 'QtdObs').value = '';
      if (TEM_CORES) {
        CORES.forEach(function (c) { $(id + 'Cor_' + c.col).value = Number(it[c.col]) || 0; });
        somarCores();
      }
      if (TEM_FOTO) carregarFoto(codigo);
      if (COMBOS) {
        preencherSelects();
        /* abre sempre sem cor escolhida: o usuario seleciona a cada contagem */
        $(id + 'CmbQ').value = '';
        $(id + 'CmbA').value = '';
        $(id + 'QtdInput').value = qtdCombo();
      }
      previaQtd();
      $(id + 'SheetQtd').classList.add('open');
      if (!TEM_CORES) setTimeout(function () { $(id + 'QtdInput').select(); }, 120);
    }

    /* lê os campos de cor do sheet e soma no campo oculto de quantidade */
    function coresDoSheet() {
      var o = {};
      CORES.forEach(function (c) { o[c.col] = num($(id + 'Cor_' + c.col).value); });
      return o;
    }

    function somarCores() {
      var cores = coresDoSheet();
      var t = 0;
      COLS_COR.forEach(function (c) { t += cores[c]; });
      $(id + 'QtdInput').value = t;
      previaQtd();
    }

    function renderOpcoes() {
      var el = $(id + 'OpcLista');
      if (!el) return;
      el.innerHTML = [['quadro', 'Quadro'], ['articulacao', 'Articulação']].map(function (t) {
        return opcoesDe(t[0]).map(function (n) {
          return '<div class="kv"><span>' + t[1] + ': ' + esc(n) + '</span>' +
            '<button class="btn ghost" type="button" data-tipo="' + t[0] + '" data-opc-del="' + esc(n) + '">Remover</button></div>';
        }).join('');
      }).join('');
    }

    /* ---------- combinacoes (cor do quadro + articulacao) ---------- */
    function opcoesDe(tipo) {
      return sel('SELECT nome FROM ' + OPC + ' WHERE tipo = ? ORDER BY nome', [tipo])
        .map(function (r) { return r.nome; });
    }

    function preencherSelects() {
      [['CmbQ', 'quadro'], ['CmbA', 'articulacao']].forEach(function (p) {
        var s = $(id + p[0]);
        var atual = s.value;
        s.innerHTML = '<option value="">Escolha...</option>' + opcoesDe(p[1]).map(function (n) {
          return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
        }).join('');
        s.value = atual;
      });
    }

    /* qtd ja contada da combinacao escolhida (0 se nenhuma) */
    function qtdCombo() {
      var q = $(id + 'CmbQ').value, a = $(id + 'CmbA').value;
      var it = estado.itemAtual;
      if (!q || !a || !it) return 0;
      return Number(escalar('SELECT qtd FROM ' + CMB +
        ' WHERE codigo = ? AND cor_quadro = ? AND cor_articulacao = ?', [it.codigo, q, a])) || 0;
    }

    /* lista, no fim do sheet, as combinacoes ja contadas da maquina aberta */
    function renderCombosContadas() {
      var el = $(id + 'CmbContadas');
      var it = estado.itemAtual;
      if (!el || !it) return;
      var qa = $(id + 'CmbQ').value, aa = $(id + 'CmbA').value;
      var linhas = sel('SELECT cor_quadro, cor_articulacao, qtd FROM ' + CMB +
        ' WHERE codigo = ? AND qtd > 0 ORDER BY cor_quadro, cor_articulacao', [it.codigo]);
      /* contagem rapida: o que esta no total da maquina mas sem combinacao de cor */
      var somaCor = 0;
      linhas.forEach(function (r) { somaCor += Number(r.qtd) || 0; });
      var atualDb = um('SELECT qtd FROM ' + TAB + ' WHERE codigo = ?', [it.codigo]);
      var semCor = Math.max(0, (atualDb ? Number(atualDb.qtd) : Number(it.qtd)) - somaCor);
      if (!linhas.length && !semCor) { el.innerHTML = '<div class="muted small">Nenhuma combinação contada ainda.</div>'; return; }
      var total = semCor;
      var htmlSemCor = semCor
        ? '<div class="kv"><span>Sem cor (quadro)</span><b>' + P.fmtNum(semCor) + '</b></div>'
        : '';
      el.innerHTML = htmlSemCor + linhas.map(function (r) {
        total += Number(r.qtd) || 0;
        var atual = r.cor_quadro === qa && r.cor_articulacao === aa;
        return '<div class="kv" data-cq="' + esc(r.cor_quadro) + '" data-ca="' + esc(r.cor_articulacao) + '" style="cursor:pointer' +
          (atual ? ';font-weight:bold' : '') + '"><span>' + esc(r.cor_quadro) + ' + ' + esc(r.cor_articulacao) +
          '</span><b>' + P.fmtNum(r.qtd) + '</b></div>';
      }).join('') + '<div class="kv"><span>Total da máquina</span><b>' + P.fmtNum(total) + '</b></div>';
      Array.prototype.forEach.call(el.querySelectorAll('[data-cq]'), function (row) {
        row.addEventListener('click', function () {
          $(id + 'CmbQ').value = row.getAttribute('data-cq');
          $(id + 'CmbA').value = row.getAttribute('data-ca');
          $(id + 'QtdInput').value = qtdCombo();
          previaQtd();
        });
      });
    }

    function previaQtd() {
      var it = estado.itemAtual;
      if (!it) return;
      var nova = num($(id + 'QtdInput').value);
      var base = COMBOS ? qtdCombo() : it.qtd;
      var d = nova - base;
      var txt = d === 0
        ? 'Sem alteração na quantidade.'
        : (P.fmtNum(base) + ' → ' + P.fmtNum(nova) + '  (' + (d > 0 ? '+' : '') + P.fmtNum(d) + ')');
      $(id + 'QtdPrevia').textContent = txt;
      if (COMBOS) renderCombosContadas();
    }

    /* grava a mudança de quantidade no cache local + histórico */
    function aplicarLocal(codigo, qtdFinal, delta, obs, cores) {
      if (TEM_CORES && cores) {
        db.run(
          'UPDATE ' + TAB + ' SET qtd = ?' +
          COLS_COR.map(function (c) { return ', ' + c + ' = ?'; }).join('') +
          ' WHERE codigo = ?',
          [qtdFinal].concat(COLS_COR.map(function (c) { return Number(cores[c]) || 0; }), [codigo])
        );
      } else {
        db.run('UPDATE ' + TAB + ' SET qtd = ? WHERE codigo = ?', [qtdFinal, codigo]);
      }
      var comCor = TEM_CORES && cores;
      db.run(
        'INSERT INTO ' + MOV + ' (codigo_item,tipo,quantidade,qtd_final,data_hora,usuario,observacao' +
          (comCor ? ',cores' : '') + ') VALUES (?,?,?,?,?,?,?' + (comCor ? ',?' : '') + ')',
        [codigo, delta > 0 ? 'ENTRADA' : 'SAIDA', Math.abs(delta), qtdFinal,
         P.agoraISO(), P.operador() || null, obs || null]
          .concat(comCor ? [JSON.stringify(cores)] : [])
      );
      salvar(true);
    }

    /* grava no cache local: qtd da combinacao, total do item e historico */
    function aplicarCombo(codigo, q, a, qtdComb, totalFinal, delta, obs) {
      db.run('INSERT OR REPLACE INTO ' + CMB + ' (codigo,cor_quadro,cor_articulacao,qtd) VALUES (?,?,?,?)',
        [codigo, q, a, qtdComb]);
      aplicarLocal(codigo, totalFinal, delta, (q + ' + ' + a) + (obs ? ' | ' + obs : ''));
    }

    function confirmarCombo() {
      var it = estado.itemAtual;
      var q = $(id + 'CmbQ').value, a = $(id + 'CmbA').value;
      if (!q || !a) { toast('Escolha a cor do quadro e da articulação', 'err'); return; }
      var nova = num($(id + 'QtdInput').value);
      if (nova < 0) { toast('Quantidade não pode ser negativa', 'err'); return; }
      var base = qtdCombo();
      var d = nova - base;
      if (d === 0) { fecharSheets(); return; }
      var obs = $(id + 'QtdObs').value.trim();

      var ok = function (total) {
        fecharSheets();
        P.vibrar(60);
        P.bip(d > 0 ? 1046 : 700, 0.1);
        toast(it.codigo + ' (' + q + ' + ' + a + '): ' + P.fmtNum(nova), 'ok');
        render();
      };

      var api = nv();
      if (!api) { aplicarCombo(it.codigo, q, a, nova, it.qtd + d, d, obs); semNuvem(); ok(it.qtd + d); return; }

      var btn = $(id + 'QtdSalvar');
      var rotulo = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Gravando na nuvem...';
      api.definirCombo(it.codigo, q, a, nova, P.operador(), obs)
        .then(function (r) {
          var novoItem = itemDaResposta(r);
          var total = novoItem ? Number(novoItem.qtd) : it.qtd + d;
          upsertLocal(novoItem);
          aplicarCombo(it.codigo, q, a, nova, total, total - it.qtd, obs);
          statusNuvem();
          ok(total);
        })
        .catch(function (e) {
          statusNuvem();
          P.vibrar([80, 60, 80]);
          P.bip(220, 0.25);
          toast('NÃO gravado: ' + e.message, 'err');
        })
        .then(function () { btn.disabled = false; btn.textContent = rotulo; });
    }

    function confirmarQtd() {
      var it = estado.itemAtual;
      if (!it) return;
      if (COMBOS) { confirmarCombo(); return; }
      if (TEM_CORES) somarCores();
      var cores = TEM_CORES ? coresDoSheet() : null;
      var nova = num($(id + 'QtdInput').value);
      if (nova < 0) { toast('Quantidade não pode ser negativa', 'err'); return; }
      var d = nova - it.qtd;
      var mudouCor = TEM_CORES && COLS_COR.some(function (c) {
        return (Number(it[c]) || 0) !== cores[c];
      });
      if (d === 0 && !mudouCor) { fecharSheets(); return; }
      var obs = $(id + 'QtdObs').value.trim();

      var ok = function (qtdFinal) {
        fecharSheets();
        P.vibrar(60);
        P.bip(qtdFinal >= it.qtd ? 1046 : 700, 0.1);
        toast('Qtd de ' + it.codigo + ': ' + P.fmtNum(qtdFinal), 'ok');
        render();
      };

      var api = nv();
      if (!api) { aplicarLocal(it.codigo, nova, d, obs, cores); semNuvem(); ok(nova); return; }

      var btn = $(id + 'QtdSalvar');
      var rotulo = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Gravando na nuvem...';

      /* absoluto: "a quantidade contada agora é esta" */
      api.definir(it.codigo, nova, true, P.operador(), obs, cores)
        .then(function (r) {
          var novoItem = itemDaResposta(r);
          var final = novoItem ? Number(novoItem.qtd) : nova;
          upsertLocal(novoItem);
          aplicarLocal(it.codigo, final, final - it.qtd, obs, cores);
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
    /* baixa uma combinacao colorida em |d| (contagem rapida "-") */
    function passoCombo(it, cb, d) {
      var nova = Math.max(0, Number(cb.qtd) + d);
      var dReal = nova - Number(cb.qtd);
      var obs = 'contagem rápida';
      var api = nv();
      if (!api) {
        aplicarCombo(it.codigo, cb.cor_quadro, cb.cor_articulacao, nova, it.qtd + dReal, dReal, obs);
        semNuvem();
        P.vibrar(25);
        render();
        return;
      }
      api.definirCombo(it.codigo, cb.cor_quadro, cb.cor_articulacao, nova, P.operador(), obs)
        .then(function (r) {
          var novoItem = itemDaResposta(r);
          var total = novoItem ? Number(novoItem.qtd) : it.qtd + dReal;
          upsertLocal(novoItem);
          aplicarCombo(it.codigo, cb.cor_quadro, cb.cor_articulacao, nova, total, total - it.qtd, obs);
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

    function passo(codigo, d) {
      var it = um('SELECT * FROM ' + TAB + ' WHERE codigo = ?', [codigo]);
      if (!it) return;
      if (it.qtd + d < 0) { P.vibrar(80); return; }

      /* "-" na contagem rapida: primeiro tira do que esta sem cor; acabando,
         tira tambem das combinacoes coloridas (a de maior quantidade). */
      if (COMBOS && d < 0) {
        var somaCor = Number(escalar('SELECT COALESCE(SUM(qtd),0) FROM ' + CMB + ' WHERE codigo = ?', [codigo])) || 0;
        if (it.qtd - somaCor < -d) {
          var cb = um('SELECT cor_quadro, cor_articulacao, qtd FROM ' + CMB +
            ' WHERE codigo = ? AND qtd > 0 ORDER BY qtd DESC, cor_quadro, cor_articulacao LIMIT 1', [codigo]);
          if (cb) { passoCombo(it, cb, d); return; }
        }
      }

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
      if (TEM_FOTO) {
        mostrarCadFoto(null);
        cadFotoMudou = false;
        if (item) {
          idbGet(IDB, 'foto_' + item.codigo)
            .then(function (v) { if (v && !cadFotoMudou) mostrarCadFoto(v); })
            .catch(function () {});
          var api = nv();
          if (api) api.puxarFoto(item.codigo)
            .then(function (u) { if (!cadFotoMudou) mostrarCadFoto(u); }).catch(function () {});
        }
      }
      $(id + 'SheetCad').classList.add('open');
    }

    /* foto escolhida na tela de cadastro: só sobe depois que o item existe */
    var cadFoto = null;        // o que está na tela
    var cadFotoMudou = false;  // o usuário trocou/removeu nesta abertura?

    function mostrarCadFoto(url) {
      cadFoto = url || null;
      var img = $(id + 'CadFotoImg');
      img.classList.toggle('hidden', !cadFoto);
      if (cadFoto) img.src = cadFoto;
      $(id + 'CadFotoVazio').classList.toggle('hidden', !!cadFoto);
      $(id + 'CadFotoDel').classList.toggle('hidden', !cadFoto);
      $(id + 'CadFotoAdd').textContent = cadFoto ? '📷 Trocar foto' : '📷 Foto';
    }

    /* depois que o item existe, manda a foto escolhida no cadastro */
    function gravarFotoCadastro(codigo) {
      if (!TEM_FOTO || !cadFotoMudou) return;
      var url = cadFoto;
      cadFotoMudou = false;
      idbSet(IDB, 'foto_' + codigo, url || null).catch(function () {});
      if (estado.itemAtual && estado.itemAtual.codigo === codigo) mostrarFoto(url);
      var api = nv();
      if (!api) { toast('Foto ficou só neste aparelho (sem nuvem)', 'err'); return; }
      var p = url ? api.salvarFoto(codigo, url, P.operador() || null) : api.apagarFoto(codigo);
      p.then(function () { toast(url ? 'Foto salva para todos' : 'Foto removida', 'ok'); })
       .catch(function (e) { toast('Foto NÃO foi para a nuvem: ' + e.message, 'err'); });
    }

    /* item excluído -> foto vai junto (local e nuvem) */
    function apagarFotoDoItem(codigo) {
      if (!TEM_FOTO) return;
      idbSet(IDB, 'foto_' + codigo, null).catch(function () {});
      var api = nv();
      if (api) api.apagarFoto(codigo).catch(function () {});
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
        gravarFotoCadastro(cod);
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
          gravarFotoCadastro(cod);
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
        if (COMBOS) db.run('DELETE FROM ' + CMB);
        var agora = P.agoraISO(), op = P.operador() || null;
        sel('SELECT codigo, qtd FROM ' + TAB + ' WHERE qtd <> 0').forEach(function (r) {
          db.run(
            'INSERT INTO ' + MOV + ' (codigo_item,tipo,quantidade,qtd_final,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?,?)',
            [r.codigo, 'ZERAGEM', r.qtd, 0, agora, op, 'zeragem geral (contagem cíclica)']
          );
        });
        db.run('UPDATE ' + TAB + ' SET qtd = 0' +
          COLS_COR.map(function (c) { return ', ' + c + ' = 0'; }).join(''));
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
        var det = textoCores(r);

        return '<div class="li' + (r.qtd > 0 ? ' contado' : '') + '">' +
          '<div class="li-main" data-' + id + 'abrir="' + esc(r.codigo) + '">' +
            '<span class="li-code">' + esc(r.codigo) + '</span>' +
            '<span class="li-nome">' + esc(r.nome) + '</span>' +
            (det ? '<span class="li-sub">' + esc(det) + '</span>' : '') +
          '</div>' +
          '<div class="li-cont">' +
            ((TEM_CORES || COMBOS) ? '' :
              '<button class="qty-btn" data-' + id + 'passo2="-1" data-cod="' + esc(r.codigo) + '" type="button">-</button>') +
            '<button class="li-qtd" data-' + id + 'abrir="' + esc(r.codigo) + '" type="button">' + P.fmtNum(r.qtd) + '</button>' +
            (TEM_CORES ? '' : COMBOS ?
              '<button class="qty-btn" data-' + id + 'abrir="' + esc(r.codigo) + '" type="button">+</button>' :
              '<button class="qty-btn" data-' + id + 'passo2="1" data-cod="' + esc(r.codigo) + '" type="button">+</button>') +
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
        var det = textoCores(coresMov(m.cores));
        return '<div class="li">' +
          '<div class="li-main">' +
            '<span class="li-code">' + esc(m.codigo_item) + '</span>' +
            '<span class="li-nome">' + esc(m.nome || '(item excluído)') + '</span>' +
            '<span class="li-sub">' + P.fmtDataHora(m.data_hora) +
              (m.usuario ? ' • ' + esc(m.usuario) : '') +
              (m.observacao ? ' • ' + esc(m.observacao) : '') +
            '</span>' +
            (det ? '<span class="li-sub">Cores: ' + esc(det) + '</span>' : '') +
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
        apagarFotoDoItem(cod);
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
      if (TEM_CORES) {
        P.qsa('.' + id + '-cor').forEach(function (inp) {
          inp.addEventListener('input', somarCores);
        });
        P.qsa('[data-' + id + 'corpasso]').forEach(function (b) {
          b.addEventListener('click', function () {
            var inp = $(id + 'Cor_' + b.getAttribute('data-' + id + 'cor'));
            inp.value = Math.max(0, num(inp.value) + parseFloat(b.getAttribute('data-' + id + 'corpasso')));
            somarCores();
          });
        });
      }
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
      /* foto na tela de cadastro */
      if (TEM_FOTO) {
        $(id + 'CadFotoAdd').addEventListener('click', function () { $(id + 'CadFotoFile').click(); });
        $(id + 'CadFotoDel').addEventListener('click', function () {
          cadFotoMudou = true; mostrarCadFoto(null);
        });
        $(id + 'CadFotoFile').addEventListener('change', function (ev) {
          var f = ev.target.files && ev.target.files[0];
          ev.target.value = '';
          if (!f) return;
          comprimir(f, function (url) { cadFotoMudou = true; mostrarCadFoto(url); });
        });
      }

      /* foto do item */
      if (TEM_FOTO) {
        $(id + 'FotoAdd').addEventListener('click', function () { $(id + 'FotoFile').click(); });
        $(id + 'FotoDel').addEventListener('click', removerFoto);
        $(id + 'FotoFile').addEventListener('change', function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (f) salvarFoto(f);
          ev.target.value = '';
        });
        $(id + 'FotoImg').addEventListener('click', abrirVisor);
        $(id + 'VisorSair').addEventListener('click', fecharVisor);

        /* botão voltar do Android */
        window.addEventListener('popstate', function () {
          if (visorAberto()) fecharVisor();
        });
        document.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape' && visorAberto()) fecharVisor();
        });

        /* zoom: pinça com 2 dedos, arrastar com 1, toque duplo alterna */
        var palco = $(id + 'VisorPalco');
        var dist = function (t) {
          var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
          return Math.sqrt(dx * dx + dy * dy);
        };
        palco.addEventListener('touchstart', function (ev) {
          if (ev.touches.length === 2) {
            vz.d0 = dist(ev.touches); vz.e0 = vz.esc; vz.arrastando = false;
          } else if (ev.touches.length === 1) {
            vz.arrastando = true;
            vz.px = ev.touches[0].clientX - vz.x;
            vz.py = ev.touches[0].clientY - vz.y;
          }
        }, { passive: true });
        palco.addEventListener('touchmove', function (ev) {
          if (ev.touches.length === 2 && vz.d0) {
            vz.esc = Math.min(6, Math.max(1, vz.e0 * (dist(ev.touches) / vz.d0)));
            if (vz.esc === 1) { vz.x = 0; vz.y = 0; }
            aplicarZoom();
            ev.preventDefault();
          } else if (vz.arrastando && ev.touches.length === 1 && vz.esc > 1) {
            vz.x = ev.touches[0].clientX - vz.px;
            vz.y = ev.touches[0].clientY - vz.py;
            aplicarZoom();
            ev.preventDefault();
          }
        }, { passive: false });
        palco.addEventListener('touchend', function () { vz.d0 = 0; vz.arrastando = false; });
        palco.addEventListener('dblclick', function () {
          vz.esc = vz.esc > 1 ? 1 : 2.5; vz.x = 0; vz.y = 0; aplicarZoom();
        });
        palco.addEventListener('wheel', function (ev) {
          vz.esc = Math.min(6, Math.max(1, vz.esc - ev.deltaY * 0.002));
          if (vz.esc === 1) { vz.x = 0; vz.y = 0; }
          aplicarZoom();
          ev.preventDefault();
        }, { passive: false });
      }

      $(id + 'QtdSalvar').addEventListener('click', confirmarQtd);
      $(id + 'CadSalvar').addEventListener('click', salvarCadastro);
      P.qsa('[data-' + id + 'fechar]').forEach(function (b) {
        b.addEventListener('click', fecharSheets);
      });

      /* configurações */
      $(id + 'Sync').addEventListener('click', function () { sincronizar(false); });
      if (COMBOS) {
        ['CmbQ', 'CmbA'].forEach(function (s) {
          $(id + s).addEventListener('change', function () {
            $(id + 'QtdInput').value = qtdCombo();
            previaQtd();
          });
        });
        $(id + 'OpcAdd').addEventListener('click', function () {
          var nome = $(id + 'OpcNome').value.trim();
          if (!nome) { toast('Digite o nome da cor', 'err'); return; }
          var tipo = $(id + 'OpcTipo').value;
          var api = nv();
          if (!api) { toast('Sem nuvem: entre online para editar a lista', 'err'); return; }
          api.opcaoAdicionar(tipo, nome).then(function () {
            db.run('INSERT OR IGNORE INTO ' + OPC + ' (tipo,nome) VALUES (?,?)', [tipo, nome]);
            salvar(true);
            $(id + 'OpcNome').value = '';
            renderOpcoes();
          }).catch(function (e) { toast('Falha: ' + e.message, 'err'); });
        });
        $(id + 'OpcLista').addEventListener('click', function (ev) {
          var b = ev.target.closest('[data-opc-del]');
          if (!b) return;
          var tipo = b.getAttribute('data-tipo'), nome = b.getAttribute('data-opc-del');
          var api = nv();
          if (!api) { toast('Sem nuvem: entre online para editar a lista', 'err'); return; }
          if (!confirm('Remover "' + nome + '" da lista? Contagens já feitas com essa cor continuam salvas.')) return;
          api.opcaoRemover(tipo, nome).then(function () {
            db.run('DELETE FROM ' + OPC + ' WHERE tipo = ? AND nome = ?', [tipo, nome]);
            salvar(true);
            renderOpcoes();
          }).catch(function (e) { toast('Falha: ' + e.message, 'err'); });
        });
        try { renderOpcoes(); } catch (e) { /* banco ainda abrindo: renderiza apos sincronizar */ }
      }
      $(id + 'Enviar').addEventListener('click', enviarDaqui);
      $(id + 'Zerar').addEventListener('click', zerarTudo);
      $(id + 'Excluir').addEventListener('click', excluirItem);
      $(id + 'Apagar').addEventListener('click', apagarTudo);
      $(id + 'EscolherCsv').addEventListener('click', function () { $(id + 'FileCsv').click(); });
      $(id + 'FileCsv').addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        P.lerTexto(f, function (txt) { importarCsv(txt); });
        ev.target.value = '';
      });
      $(id + 'Relatorio').addEventListener('click', function () {
        var linhas = sel('SELECT codigo, nome, qtd FROM ' + TAB +
                         ' WHERE COALESCE(qtd,0) <> 0 ORDER BY codigo');
        if (!linhas.length) { toast('Nenhum item com quantidade contada', 'err'); return; }
        var txt;
        if (COMBOS) {
          /* uma linha por combinacao (iguais ja vem agrupadas); o que foi
             contado sem cor (contagem rapida) entra como "Sem cor" */
          var saida = [];
          linhas.forEach(function (r) {
            var cs = sel('SELECT cor_quadro, cor_articulacao, qtd FROM ' + CMB +
              ' WHERE codigo = ? AND qtd > 0 ORDER BY cor_quadro, cor_articulacao', [r.codigo]);
            var soma = 0;
            cs.forEach(function (c) {
              soma += c.qtd;
              saida.push({ Cod: r.codigo, Nome: r.nome, Quadro: c.cor_quadro,
                           Articulacao: c.cor_articulacao, Qtd: c.qtd, Total: r.qtd });
            });
            if (r.qtd - soma > 0) {
              saida.push({ Cod: r.codigo, Nome: r.nome, Quadro: 'Sem cor',
                           Articulacao: 'Sem cor', Qtd: r.qtd - soma, Total: r.qtd });
            }
          });
          txt = P.csvDe(['Cod', 'Nome', 'Quadro', 'Articulacao', 'Qtd', 'Total'], saida);
        } else {
          txt = P.csvDe(['Cod', 'Nome', 'Qtd'], linhas.map(function (r) {
            return { Cod: r.codigo, Nome: r.nome, Qtd: r.qtd };
          }));
        }
        P.baixar(new Blob([txt], { type: 'text/csv;charset=utf-8' }), id + '_relatorio_' + P.carimbo() + '.csv');
        toast('Relatório gerado (pasta Downloads)', 'ok');
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
