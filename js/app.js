/* ============================================================
   Controle PCP LION — PWA multi-funcoes do PCP (almoxarifado PBA e outros modulos)
   Banco: SQLite (sql.js / WebAssembly) persistido em IndexedDB
   ============================================================ */
(function () {
'use strict';

var APP_VERSION = '1.14.0';

/* ---------------------------------------------------------
   Atalhos DOM
--------------------------------------------------------- */
function $(id) { return document.getElementById(id); }
function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

var toastTimer = null;
function toast(msg, kind) {
  var t = $('toast');
  t.className = 'toast show ' + (kind || '');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
}

function vibrar(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

/* Bipe curto via WebAudio (sem arquivo externo) */
var audioCtx = null;
function bip(freq, dur) {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    var o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = freq || 880;
    g.gain.value = 0.06;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + (dur || 0.12));
  } catch (e) {}
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}
function parseNum(v) {
  if (v == null) return 0;
  var s = String(v).trim().replace(/\s/g, '');
  if (!s) return 0;
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function agoraISO() {
  var d = new Date(), p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function fmtDataHora(s) {
  if (!s) return '';
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  return m ? (m[3] + '/' + m[2] + '/' + m[1] + ' ' + m[4] + ':' + m[5]) : s;
}

/* ---------------------------------------------------------
   IndexedDB (armazena o arquivo .db em bytes)
--------------------------------------------------------- */
var IDB_NAME = 'almox_pba', IDB_STORE = 'kv';
function idbOpen() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = function () {
      if (!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE);
    };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function idbSet(key, val) {
  return idbOpen().then(function (db) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = function () { db.close(); res(true); };
      tx.onerror = function () { db.close(); rej(tx.error); };
    });
  });
}
function idbGet(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(IDB_STORE, 'readonly');
      var rq = tx.objectStore(IDB_STORE).get(key);
      rq.onsuccess = function () { db.close(); res(rq.result); };
      rq.onerror = function () { db.close(); rej(rq.error); };
    });
  });
}

/* ---------------------------------------------------------
   Banco SQLite
--------------------------------------------------------- */
var SQL = null, db = null, saveTimer = null;

var SCHEMA = [
  'CREATE TABLE IF NOT EXISTS itens (',
  '  codigo TEXT PRIMARY KEY,',
  '  nome TEXT NOT NULL,',
  '  descricao TEXT,',
  '  unidade_medida TEXT DEFAULT "UN",',
  '  estoque_atual REAL NOT NULL DEFAULT 0,',
  '  estoque_minimo REAL DEFAULT 0,',
  '  data_cadastro DATETIME',
  ');',
  'CREATE TABLE IF NOT EXISTS movimentacoes (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  codigo_item TEXT NOT NULL REFERENCES itens(codigo),',
  '  tipo TEXT NOT NULL,',
  '  quantidade REAL NOT NULL,',
  '  data_hora DATETIME NOT NULL,',
  '  usuario TEXT,',
  '  observacao TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS ix_mov_item ON movimentacoes(codigo_item);',
  'CREATE INDEX IF NOT EXISTS ix_mov_data ON movimentacoes(data_hora);'
].join('\n');

function iniciarSQL() {
  return initSqlJs({ locateFile: function (f) { return './vendor/' + f; } })
    .then(function (sql) {
      SQL = sql;
      return idbGet('dbfile');
    })
    .then(function (bytes) {
      if (bytes && bytes.byteLength) {
        try { db = new SQL.Database(new Uint8Array(bytes)); }
        catch (e) { db = new SQL.Database(); }
      } else {
        db = new SQL.Database();
      }
      db.run(SCHEMA);
    });
}

/* Salva o banco no IndexedDB (com debounce) */
function salvar(imediato) {
  clearTimeout(saveTimer);
  var run = function () {
    try {
      var bytes = db.export();
      idbSet('dbfile', bytes).then(function () {
        localStorage.setItem('ultimo_salvamento', agoraISO());
        atualizarStats();
      });
    } catch (e) { toast('Erro ao salvar: ' + e.message, 'err'); }
  };
  if (imediato) run(); else saveTimer = setTimeout(run, 400);
}

/* Consulta -> array de objetos */
function sel(sql, params) {
  var out = [];
  var st = db.prepare(sql);
  if (params) st.bind(params);
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}
function um(sql, params) { var r = sel(sql, params); return r.length ? r[0] : null; }
function escalar(sql, params) {
  var r = um(sql, params);
  if (!r) return 0;
  var k = Object.keys(r)[0];
  return r[k];
}

/* ---------------------------------------------------------
   SINCRONIZAÇÃO COM A NUVEM (Supabase)
   A nuvem é a fonte oficial. O SQLite local vira um cache
   de leitura, para o app abrir rápido e permitir consulta
   mesmo se o sinal cair.
--------------------------------------------------------- */
function nuvemStatus(txt, cls) {
  var d = $('nuvemDot'); if (d) d.className = 'chip dot ' + cls;
  var h = $('hubNuvemDot'); if (h) { h.className = 'chip dot ' + cls; h.title = txt; }
  var e = $('nuvemEstado'); if (e) e.textContent = txt;
}

function atualizarStatusNuvem() {
  if (!Nuvem.ativa()) { nuvemStatus('Não configurado (dados só neste aparelho)', 'off'); return; }
  if (Nuvem.conectado()) nuvemStatus('Conectado', 'on');
  else nuvemStatus('Sem conexão com a nuvem', 'err');
}

/* converte data ISO (UTC) da nuvem para o horário local */
function paraLocal(iso) {
  if (!iso) return agoraISO();
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* substitui o cache local pelo conteúdo da nuvem */
function gravarCache(dados) {
  db.run('BEGIN');
  try {
    db.run('DELETE FROM movimentacoes');
    db.run('DELETE FROM itens');
    dados.itens.forEach(function (it) {
      db.run('INSERT INTO itens (codigo,nome,descricao,unidade_medida,estoque_atual,estoque_minimo,data_cadastro) VALUES (?,?,?,?,?,?,?)',
        [it.codigo, it.nome, it.descricao || null, it.unidade_medida || 'UN',
         Number(it.estoque_atual) || 0, Number(it.estoque_minimo) || 0, paraLocal(it.data_cadastro)]);
    });
    dados.movimentacoes.forEach(function (m) {
      db.run('INSERT INTO movimentacoes (id,codigo_item,tipo,quantidade,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?,?)',
        [m.id, m.codigo_item, m.tipo, Number(m.quantidade) || 0,
         paraLocal(m.data_hora), m.usuario || null, m.observacao || null]);
    });
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (e2) {}
    throw e;
  }
  salvar(true);
}

function repintar() {
  atualizarStats();
  if (estado.view === 'estoque') renderEstoque();
  else if (estado.view === 'hist') renderHistorico();
  else if (estado.view === 'item' && estado.itemAtual) abrirItem(estado.itemAtual.codigo);
}

function sincronizar(silencioso) {
  if (!Nuvem.ativa()) { atualizarStatusNuvem(); return Promise.resolve(false); }
  nuvemStatus('Sincronizando...', 'sync');
  /* com muitos itens a descida vem em varias paginas - mostra o andamento */
  var progresso = function (nItens, nMov) {
    nuvemStatus('Baixando... ' + nItens + ' itens' + (nMov ? ' • ' + nMov + ' mov.' : ''), 'sync');
  };
  return Nuvem.puxarTudo(null, progresso).then(function (d) {
    /* trava de seguranca: nuvem vazia NUNCA apaga o que existe neste aparelho.
       Acontece ao conectar pela 1a vez numa base nova - os dados locais
       precisam ser enviados antes (botao "Enviar itens deste aparelho"). */
    if (!d.itens.length && escalar('SELECT COUNT(*) FROM itens') > 0) {
      atualizarStatusNuvem();
      if (!silencioso) toast('A nuvem está vazia. Envie os itens deste aparelho primeiro.', 'err');
      return false;
    }
    gravarCache(d);
    atualizarStatusNuvem();
    repintar();
    if (!silencioso) toast('Sincronizado • ' + d.itens.length + ' itens', 'ok');
    return true;
  }).catch(function (e) {
    atualizarStatusNuvem();
    if (!silencioso) toast('Falha ao sincronizar: ' + e.message, 'err');
    return false;
  });
}

/* aplica no cache local o item devolvido pela nuvem */
function itemDaResposta(r) {
  if (!r) return null;
  return Array.isArray(r) ? (r[0] || null) : r;
}

function upsertLocal(it) {
  if (!it) return;
  var ex = um('SELECT codigo FROM itens WHERE codigo=$c', { $c: it.codigo });
  if (ex) {
    db.run('UPDATE itens SET nome=?,descricao=?,unidade_medida=?,estoque_atual=?,estoque_minimo=? WHERE codigo=?',
      [it.nome, it.descricao || null, it.unidade_medida || 'UN',
       Number(it.estoque_atual) || 0, Number(it.estoque_minimo) || 0, it.codigo]);
  } else {
    db.run('INSERT INTO itens (codigo,nome,descricao,unidade_medida,estoque_atual,estoque_minimo,data_cadastro) VALUES (?,?,?,?,?,?,?)',
      [it.codigo, it.nome, it.descricao || null, it.unidade_medida || 'UN',
       Number(it.estoque_atual) || 0, Number(it.estoque_minimo) || 0, paraLocal(it.data_cadastro)]);
  }
}

/* ---------------------------------------------------------
   Estado da UI
--------------------------------------------------------- */
var estado = {
  modulo: null,
  view: 'estoque',
  itemAtual: null,
  filtroEstoque: 'todos',
  histTipo: 'TODOS',
  histPeriodo: 0,
  movTipo: 'ENTRADA',
  editando: false,
  scanAtivo: false
};

/* Com login ativo o operador é o usuário da sessão (não dá para
   digitar outro nome no histórico). Sem cofre, cai no nome manual. */
function operador() {
  return Auth.usuario() || localStorage.getItem('operador') || '';
}

/* ---------------------------------------------------------
   PONTE PARA OS MÓDULOS EXTERNOS

   O app.js roda dentro de uma IIFE, então os módulos que moram
   em outros arquivos (ex.: js/contagem.js) recebem por aqui os
   utilitários compartilhados. Cada módulo tem o SEU banco, mas
   o visual e os avisos continuam iguais em todo o app.
--------------------------------------------------------- */
window.PCP = {
  $: $, qsa: qsa, esc: esc,
  toast: toast, vibrar: vibrar, bip: bip,
  fmtNum: fmtNum, agoraISO: agoraISO, fmtDataHora: fmtDataHora,
  carimbo: carimbo, baixar: baixar, csvDe: csvDe, paraLocal: paraLocal,
  lerTexto: lerTexto,
  atualizarStatusNuvem: function () { atualizarStatusNuvem(); },
  nuvemStatus: function (t, c) { nuvemStatus(t, c); },
  operador: function () { return operador(); },
  mostrarView: function (n) { mostrarView(n); }
};

/* ---------------------------------------------------------
   HUB DE FUNÇÕES

   Cada módulo do Controle PCP LION é independente: tem seu
   próprio título, suas próprias views (marcadas no HTML com
   data-modulo) e mais para frente suas próprias tabelas.
   Para adicionar uma função nova:
     1. criar as <section class="view" data-modulo="xxx"> no
        index.html e os <button class="tab" data-modulo="xxx">;
     2. registrar o módulo aqui embaixo em MODULOS;
     3. (se precisar) criar as tabelas no db.js do módulo.
--------------------------------------------------------- */
var MODULOS = [
  {
    id: 'almox',
    nome: 'Almoxarifado PBA',
    desc: 'Entrada e saída de estoque por QR Code. Itens, movimentações e estoque baixo.',
    icone: '📦',
    titulo: 'Almoxarifado',
    viewInicial: 'estoque',
    pronto: true
  },
  {
    id: 'quadro',
    nome: 'Contagem de Quadros VG',
    desc: 'Contagem cíclica de quadros na produção. Banco próprio: quadros / movimentacoes_quadros.',
    icone: '🔢',
    titulo: 'Contagem de Quadros VG',
    viewInicial: 'quadro-cont',
    pronto: true,
    tipo: 'contagem',
    tabela: 'quadros',
    tabelaMov: 'movimentacoes_quadros',
    unidade: 'pç'
  },
  {
    id: 'carenagem',
    nome: 'Carenagens VG',
    desc: 'Contagem cíclica de carenagens. Banco próprio: carenagens / movimentacoes_carenagens.',
    icone: '🛡️',
    titulo: 'Carenagens VG',
    viewInicial: 'carenagem-cont',
    pronto: true,
    tipo: 'contagem',
    tabela: 'carenagens',
    tabelaMov: 'movimentacoes_carenagens',
    unidade: 'pç'
  },
  {
    id: 'eficiencia',
    nome: 'Eficiência VG',
    desc: 'Controle diário de faltas e horas extras da produção, por setor. Histórico de 10 dias.',
    icone: '⏱️',
    titulo: 'Eficiência VG',
    viewInicial: 'eficiencia-dia',
    pronto: true,
    tipo: 'eficiencia'
  }
];

/* Cada "tipo" de módulo tem um motor que sabe montar a tela e
   abrir o banco dele. Módulo sem tipo (Almoxarifado PBA) roda
   direto no app.js. */
function motorDoTipo(tipo) {
  if (tipo === 'contagem') return window.ModuloContagem;
  if (tipo === 'eficiencia') return window.ModuloEficiencia;
  return null;
}

function motoresAtivos() {
  return [window.ModuloContagem, window.ModuloEficiencia].filter(Boolean);
}

function moduloPorId(id) {
  for (var i = 0; i < MODULOS.length; i++) if (MODULOS[i].id === id) return MODULOS[i];
  return null;
}

function renderHub() {
  var g = $('hubGrid');
  if (!g) return;
  g.innerHTML = '';
  MODULOS.forEach(function (m) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'hub-card' + (m.pronto ? '' : ' breve');
    b.innerHTML =
      '<span class="hc-icone">' + m.icone + '</span>' +
      '<span class="hc-txt">' +
        '<span class="hc-nome">' + esc(m.nome) + '</span>' +
        '<span class="hc-desc">' + esc(m.desc) + '</span>' +
      '</span>' +
      '<span class="hc-seta">' + (m.pronto ? '›' : 'em breve') + '</span>';
    b.addEventListener('click', function () {
      if (!m.pronto) { toast('Função "' + m.nome + '" ainda não disponível', 'err'); return; }
      abrirModulo(m.id);
    });
    g.appendChild(b);
  });

  var u = $('hubUser');
  if (u) u.textContent = Auth.atual() ? Auth.usuario() : (operador() || 'operador');
  var v = $('hubVersao');
  if (v) v.textContent = APP_VERSION;
}

function mostrarHub() {
  estado.modulo = null;
  pararScanner();
  fecharSheets();
  qsa('.sheet-wrap.open').forEach(function (s) { s.classList.remove('open'); });
  $('hub').classList.remove('hidden');
  $('topbar').classList.add('hidden');
  $('main').classList.add('hidden');
  qsa('[data-modulo]').forEach(function (el) { el.classList.add('hidden'); });
  renderHub();
  atualizarStatusNuvem();
  window.scrollTo(0, 0);
}

function abrirModulo(id) {
  var m = moduloPorId(id);
  if (!m || !m.pronto) return;

  /* módulos externos têm banco próprio e a tela é montada
     na primeira vez que o módulo é aberto */
  var motor = motorDoTipo(m.tipo);
  if (motor) {
    var inst = motor.obter(m);
    $('hubSub').textContent = 'Abrindo ' + m.nome + '...';
    inst.preparar().then(function () {
      $('hubSub').textContent = 'Selecione uma função';
      entrarNoModulo(m);
    }).catch(function (e) {
      $('hubSub').textContent = 'Selecione uma função';
      toast('Falha ao abrir o banco de "' + m.nome + '": ' + (e && e.message), 'err');
    });
    return;
  }

  entrarNoModulo(m);
}

function entrarNoModulo(m) {
  var id = m.id;
  estado.modulo = id;

  $('hub').classList.add('hidden');
  $('topbar').classList.remove('hidden');
  $('main').classList.remove('hidden');
  $('topTitle').textContent = m.titulo;

  /* o quadradinho da topbar vira o mesmo icone do card do hub */
  var lg = $('topLogo');
  if (lg) {
    if (m.icone) { lg.textContent = m.icone; lg.classList.add('emoji'); }
    else { lg.textContent = 'PBA'; lg.classList.remove('emoji'); }
    lg.title = m.nome;
  }

  /* só as views e abas do módulo escolhido ficam disponíveis */
  qsa('[data-modulo]').forEach(function (el) {
    el.classList.toggle('hidden', el.dataset.modulo !== id);
  });

  if (m.viewInicial) mostrarView(m.viewInicial);
  window.scrollTo(0, 0);
}

function mostrarView(nome) {
  estado.view = nome;
  qsa('.view').forEach(function (v) { v.classList.remove('active'); });
  var el = $('view-' + nome);
  if (el) el.classList.add('active');
  qsa('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === nome); });
  if (nome !== 'scan') pararScanner();
  window.scrollTo(0, 0);
  if (nome === 'scan') setTimeout(iniciarScanner, 60);
  if (nome === 'estoque') renderEstoque();
  if (nome === 'hist') renderHistorico();
  if (nome === 'dados') atualizarStats();
  /* deixa os módulos externos atualizarem as telas deles */
  motoresAtivos().forEach(function (mo) { mo.aoMostrarView(nome); });
}

/* ---------------------------------------------------------
   ESTOQUE
--------------------------------------------------------- */
function renderEstoque() {
  var termo = ($('buscaEstoque').value || '').trim().toLowerCase();
  var sql = 'SELECT * FROM itens';
  var cond = [], par = {};
  if (termo) {
    cond.push('(LOWER(codigo) LIKE $t OR LOWER(nome) LIKE $t OR LOWER(IFNULL(descricao,"")) LIKE $t)');
    par.$t = '%' + termo + '%';
  }
  if (estado.filtroEstoque === 'zerado') cond.push('estoque_atual <= 0');
  if (estado.filtroEstoque === 'baixo') cond.push('IFNULL(estoque_minimo,0) > 0 AND estoque_atual <= IFNULL(estoque_minimo,0)');
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY nome COLLATE NOCASE LIMIT 400';

  var itens = sel(sql, Object.keys(par).length ? par : null);
  var box = $('listaEstoque');

  var total = escalar('SELECT COUNT(*) FROM itens');
  $('resumoEstoque').textContent = itens.length + ' de ' + total + ' itens';

  if (!itens.length) {
    box.innerHTML = '<div class="vazio">' +
      (total === 0
        ? 'Nenhum item cadastrado ainda.<br>Vá em <b>Dados &rarr; Importar itens (CSV)</b><br>ou cadastre manualmente.'
        : 'Nenhum item encontrado para esse filtro.') + '</div>';
    return;
  }

  box.innerHTML = itens.map(function (it) {
    var min = Number(it.estoque_minimo) || 0;
    var saldo = Number(it.estoque_atual) || 0;
    var cls = saldo <= 0 ? 'zerado' : (min > 0 && saldo <= min ? 'baixo' : '');
    return '<button class="li ' + cls + '" data-codigo="' + esc(it.codigo) + '">' +
      '<div class="li-main">' +
        '<div class="li-code">' + esc(it.codigo) + '</div>' +
        '<div class="li-nome">' + esc(it.nome) + '</div>' +
        (it.descricao ? '<div class="li-sub">' + esc(it.descricao) + '</div>' : '') +
      '</div>' +
      '<div class="li-saldo"><b>' + fmtNum(saldo) + '</b><small>' + esc(it.unidade_medida || 'UN') + '</small></div>' +
    '</button>';
  }).join('');

  qsa('#listaEstoque .li').forEach(function (b) {
    b.addEventListener('click', function () { abrirItem(b.dataset.codigo); });
  });
}

/* ---------------------------------------------------------
   ITEM
--------------------------------------------------------- */
function normalizarCodigo(txt) {
  if (!txt) return '';
  var s = String(txt).trim();
  // QR pode conter JSON  {"codigo":"X"} / {"payload":"X"}
  if (s.charAt(0) === '{') {
    try {
      var o = JSON.parse(s);
      s = o.codigo || o.code || o.payload || o.serial || o.id || s;
    } catch (e) {}
  }
  // QR pode conter URL  https://...?codigo=X  ou  .../X
  if (/^https?:\/\//i.test(s)) {
    try {
      var u = new URL(s);
      s = u.searchParams.get('codigo') || u.searchParams.get('code') ||
          u.searchParams.get('c') || u.hash.replace('#', '') ||
          u.pathname.split('/').filter(Boolean).pop() || s;
    } catch (e) {}
  }
  return String(s).trim();
}

function buscarItem(codigo) {
  var c = normalizarCodigo(codigo);
  if (!c) return null;
  return um('SELECT * FROM itens WHERE codigo = $c', { $c: c }) ||
         um('SELECT * FROM itens WHERE UPPER(codigo) = $c', { $c: c.toUpperCase() });
}

function abrirItem(codigo) {
  var it = buscarItem(codigo);
  if (!it) { itemNaoEncontrado(codigo); return; }
  estado.itemAtual = it;

  var saldo = Number(it.estoque_atual) || 0;
  var min = Number(it.estoque_minimo) || 0;

  $('itemCodigo').textContent = it.codigo;
  $('itemNome').textContent = it.nome;
  $('itemDescricao').textContent = it.descricao || '';
  $('itemDescricao').classList.toggle('hidden', !it.descricao);
  $('itemSaldo').textContent = fmtNum(saldo);
  $('itemUnidade').textContent = it.unidade_medida || 'UN';
  $('itemMinimo').textContent = min > 0 ? ('Estoque mínimo: ' + fmtNum(min)) : '';

  var sv = document.querySelector('.saldo-valor');
  sv.classList.remove('baixo', 'zerado');
  if (saldo <= 0) sv.classList.add('zerado');
  else if (min > 0 && saldo <= min) sv.classList.add('baixo');

  var movs = sel('SELECT * FROM movimentacoes WHERE codigo_item=$c ORDER BY id DESC LIMIT 15', { $c: it.codigo });
  $('itemHistorico').innerHTML = movs.length
    ? movs.map(linhaMov).join('')
    : '<div class="vazio">Nenhuma movimentação registrada.</div>';

  mostrarView('item');

  /* confere o saldo oficial na nuvem antes do operador dar baixa */
  if (Nuvem.ativa() && !estado.conferindo) {
    estado.conferindo = true;
    Nuvem.puxarItem(it.codigo).then(function (n) {
      estado.conferindo = false;
      atualizarStatusNuvem();
      if (!n) return;
      var mudou = Number(n.estoque_atual) !== saldo;
      upsertLocal(n);
      if (mudou) {
        salvar(true);
        if (estado.view === 'item' && estado.itemAtual && estado.itemAtual.codigo === it.codigo) abrirItem(it.codigo);
      }
    }).catch(function () { estado.conferindo = false; atualizarStatusNuvem(); });
  }
}

function linhaMov(m, comNome) {
  var ent = m.tipo === 'ENTRADA';
  var sub = [fmtDataHora(m.data_hora)];
  if (m.usuario) sub.push(m.usuario);
  if (m.observacao) sub.push(m.observacao);
  return '<div class="li">' +
    '<span class="badge ' + (ent ? 'e' : 's') + '">' + (ent ? 'ENT' : 'SAI') + '</span>' +
    '<div class="li-main">' +
      (comNome ? '<div class="li-code">' + esc(m.codigo_item) + '</div>' +
                 '<div class="li-nome">' + esc(m.nome || '') + '</div>' : '') +
      '<div class="li-sub">' + esc(sub.join(' • ')) + '</div>' +
    '</div>' +
    '<div class="li-saldo"><b style="color:' + (ent ? 'var(--ok)' : 'var(--danger)') + '">' +
      (ent ? '+' : '−') + fmtNum(m.quantidade) + '</b></div>' +
  '</div>';
}

function itemNaoEncontrado(codigo) {
  var c = normalizarCodigo(codigo);
  vibrar([80, 60, 80]);
  bip(220, 0.2);
  if (confirm('Item não cadastrado:\n\n' + c + '\n\nDeseja cadastrar agora?')) {
    abrirCadastro(null, c);
  } else {
    mostrarView('scan');
  }
}

/* ---------------------------------------------------------
   MOVIMENTAÇÃO
--------------------------------------------------------- */
function abrirMov(tipo) {
  if (!estado.itemAtual) return;
  estado.movTipo = tipo;
  var it = estado.itemAtual;
  $('movTitulo').textContent = tipo === 'ENTRADA' ? '➕ Entrada de estoque' : '➖ Saída de estoque';
  $('movNome').textContent = it.nome;
  $('movSaldoAtual').textContent = it.codigo + ' • saldo: ' + fmtNum(it.estoque_atual) + ' ' + (it.unidade_medida || 'UN');
  $('movQtd').value = '1';
  $('movObs').value = '';
  $('btnMovConfirmar').className = 'btn ' + (tipo === 'ENTRADA' ? 'entrada' : 'saida');
  atualizarPrevia();
  $('sheetMov').classList.add('open');
  setTimeout(function () { $('movQtd').select(); }, 120);
}

function atualizarPrevia() {
  var it = estado.itemAtual; if (!it) return;
  var q = parseNum($('movQtd').value);
  var atual = Number(it.estoque_atual) || 0;
  var novo = estado.movTipo === 'ENTRADA' ? atual + q : atual - q;
  var p = $('movPrevia');
  p.className = 'previa' + (novo < 0 ? ' erro' : '');
  p.innerHTML = 'Saldo: ' + fmtNum(atual) + ' &rarr; <b>' + fmtNum(novo) + '</b> ' +
    esc(it.unidade_medida || 'UN') + (novo < 0 ? ' &nbsp;⚠ saldo negativo' : '');
}

function confirmarMov() {
  var it = estado.itemAtual; if (!it) return;
  var q = parseNum($('movQtd').value);
  if (q <= 0) { toast('Informe uma quantidade maior que zero', 'err'); return; }

  var atual = Number(it.estoque_atual) || 0;
  var ent = estado.movTipo === 'ENTRADA';
  var novo = ent ? atual + q : atual - q;

  if (!ent && q > atual) {
    if (!confirm('Saída maior que o saldo disponível (' + fmtNum(atual) + ').\n' +
                 'O saldo ficará negativo (' + fmtNum(novo) + ').\n\nConfirmar mesmo assim?')) return;
  }

  var obs = ($('movObs').value || '').trim();

  /* ---- com nuvem: a gravação oficial é no servidor ---- */
  if (Nuvem.ativa()) {
    var btn = $('btnMovConfirmar');
    var rotulo = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Gravando na nuvem...';

    Nuvem.registrarMov(it.codigo, estado.movTipo, q, operador(), obs, true)
      .then(function (r) {
        var novoItem = itemDaResposta(r);
        var saldoFinal = novoItem ? Number(novoItem.estoque_atual) : novo;
        upsertLocal(novoItem || { codigo: it.codigo, nome: it.nome, descricao: it.descricao,
                                  unidade_medida: it.unidade_medida, estoque_atual: saldoFinal,
                                  estoque_minimo: it.estoque_minimo });
        db.run('INSERT INTO movimentacoes (codigo_item,tipo,quantidade,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?)',
          [it.codigo, estado.movTipo, q, agoraISO(), operador() || null, obs || null]);
        salvar(true);
        atualizarStatusNuvem();
        fecharSheets();
        vibrar(60);
        bip(ent ? 1046 : 700, 0.1);
        toast((ent ? 'Entrada' : 'Saída') + ' de ' + fmtNum(q) + ' registrada. Saldo: ' + fmtNum(saldoFinal), 'ok');
        abrirItem(it.codigo);
      })
      .catch(function (e) {
        atualizarStatusNuvem();
        vibrar([80, 60, 80]);
        bip(220, 0.25);
        toast('NÃO gravado: ' + e.message, 'err');
      })
      .then(function () { btn.disabled = false; btn.textContent = rotulo; });
    return;
  }

  /* ---- sem nuvem: só neste aparelho ---- */
  try {
    db.run('BEGIN');
    db.run('INSERT INTO movimentacoes (codigo_item,tipo,quantidade,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?)',
      [it.codigo, estado.movTipo, q, agoraISO(), operador() || null, obs || null]);
    db.run('UPDATE itens SET estoque_atual = ? WHERE codigo = ?', [novo, it.codigo]);
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (e2) {}
    toast('Erro ao gravar: ' + e.message, 'err');
    return;
  }

  salvar(true);
  fecharSheets();
  vibrar(60);
  bip(ent ? 1046 : 700, 0.1);
  toast((ent ? 'Entrada' : 'Saída') + ' de ' + fmtNum(q) + ' registrada. Saldo: ' + fmtNum(novo), 'ok');
  abrirItem(it.codigo);
}

function fecharSheets() {
  $('sheetMov').classList.remove('open');
  $('sheetItem').classList.remove('open');
}

/* ---------------------------------------------------------
   CADASTRO DE ITEM
--------------------------------------------------------- */
function abrirCadastro(item, codigoSugerido) {
  estado.editando = !!item;
  $('cadTitulo').textContent = item ? 'Editar item' : 'Novo item';
  $('cadCodigo').value = item ? item.codigo : (codigoSugerido || '');
  $('cadCodigo').readOnly = !!item;
  $('cadNome').value = item ? item.nome : '';
  $('cadDesc').value = item ? (item.descricao || '') : '';
  $('cadUnidade').value = item ? (item.unidade_medida || 'UN') : 'UN';
  $('cadMinimo').value = item ? (item.estoque_minimo || 0) : 0;
  $('cadSaldo').value = item ? (item.estoque_atual || 0) : 0;
  $('cadSaldoWrap').classList.toggle('hidden', !!item);
  $('sheetItem').classList.add('open');
}

function salvarCadastro() {
  var cod = ($('cadCodigo').value || '').trim();
  var nome = ($('cadNome').value || '').trim();
  if (!cod) { toast('Informe o código', 'err'); return; }
  if (!nome) { toast('Informe o nome', 'err'); return; }

  var desc = ($('cadDesc').value || '').trim() || null;
  var un = ($('cadUnidade').value || 'UN').trim().toUpperCase();
  var min = parseNum($('cadMinimo').value);

  /* ---- com nuvem ---- */
  if (Nuvem.ativa()) {
    var btnC = $('btnCadSalvar');
    var rotC = btnC.textContent;
    btnC.disabled = true; btnC.textContent = 'Salvando...';

    var acao = estado.editando
      ? Nuvem.editarItem(cod, { nome: nome, descricao: desc, unidade_medida: un, estoque_minimo: min })
      : Nuvem.cadastrarItem({ codigo: cod, nome: nome, descricao: desc, unidade_medida: un,
                              estoque_atual: parseNum($('cadSaldo').value), estoque_minimo: min }, operador());

    acao.then(function (r) {
      upsertLocal(itemDaResposta(r) || { codigo: cod, nome: nome, descricao: desc,
        unidade_medida: un, estoque_atual: parseNum($('cadSaldo').value), estoque_minimo: min });
      salvar(true);
      atualizarStatusNuvem();
      fecharSheets();
      toast('Item salvo na nuvem', 'ok');
      if (!estado.editando) sincronizar(true);
      abrirItem(cod);
    }).catch(function (e) {
      atualizarStatusNuvem();
      toast('NÃO salvo: ' + e.message, 'err');
    }).then(function () { btnC.disabled = false; btnC.textContent = rotC; });
    return;
  }

  /* ---- sem nuvem ---- */
  try {
    if (estado.editando) {
      db.run('UPDATE itens SET nome=?,descricao=?,unidade_medida=?,estoque_minimo=? WHERE codigo=?',
        [nome, desc, un, min, cod]);
    } else {
      if (um('SELECT codigo FROM itens WHERE codigo=$c', { $c: cod })) {
        toast('Já existe um item com esse código', 'err'); return;
      }
      var saldo = parseNum($('cadSaldo').value);
      db.run('INSERT INTO itens (codigo,nome,descricao,unidade_medida,estoque_atual,estoque_minimo,data_cadastro) VALUES (?,?,?,?,?,?,?)',
        [cod, nome, desc, un, saldo, min, agoraISO()]);
      if (saldo > 0) {
        db.run('INSERT INTO movimentacoes (codigo_item,tipo,quantidade,data_hora,usuario,observacao) VALUES (?,?,?,?,?,?)',
          [cod, 'ENTRADA', saldo, agoraISO(), operador() || null, 'Estoque inicial (cadastro)']);
      }
    }
  } catch (e) { toast('Erro: ' + e.message, 'err'); return; }

  salvar(true);
  fecharSheets();
  toast('Item salvo', 'ok');
  abrirItem(cod);
}

/* ---------------------------------------------------------
   HISTÓRICO
--------------------------------------------------------- */
function renderHistorico() {
  var termo = ($('buscaHist').value || '').trim().toLowerCase();
  var cond = [], par = {};
  if (estado.histTipo !== 'TODOS') { cond.push('m.tipo = $tp'); par.$tp = estado.histTipo; }
  if (estado.histPeriodo > 0) {
    var d = new Date(); d.setDate(d.getDate() - (estado.histPeriodo - 1)); d.setHours(0, 0, 0, 0);
    var p = function (x) { return String(x).padStart(2, '0'); };
    par.$dt = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' 00:00:00';
    cond.push('m.data_hora >= $dt');
  }
  if (termo) {
    cond.push('(LOWER(m.codigo_item) LIKE $t OR LOWER(IFNULL(i.nome,"")) LIKE $t OR LOWER(IFNULL(m.observacao,"")) LIKE $t OR LOWER(IFNULL(m.usuario,"")) LIKE $t)');
    par.$t = '%' + termo + '%';
  }
  var sql = 'SELECT m.*, i.nome AS nome FROM movimentacoes m LEFT JOIN itens i ON i.codigo = m.codigo_item' +
            (cond.length ? ' WHERE ' + cond.join(' AND ') : '') +
            ' ORDER BY m.id DESC LIMIT 300';
  var movs = sel(sql, Object.keys(par).length ? par : null);
  $('listaHist').innerHTML = movs.length
    ? movs.map(function (m) { return linhaMov(m, true); }).join('')
    : '<div class="vazio">Nenhuma movimentação encontrada.</div>';
}

/* ---------------------------------------------------------
   SCANNER QR
--------------------------------------------------------- */
var qr = null;
function iniciarScanner() {
  if (estado.scanAtivo) return;
  if (!window.Html5Qrcode) { toast('Biblioteca de leitura não carregada', 'err'); return; }
  if (!location.protocol.match(/^https/) && location.hostname !== 'localhost') {
    toast('A câmera exige HTTPS', 'err'); return;
  }
  qr = qr || new Html5Qrcode('reader', { verbose: false });
  $('scanHint').textContent = 'Iniciando câmera...';

  var cfg = {
    fps: 12,
    qrbox: function (w, h) {
      var m = Math.floor(Math.min(w, h) * 0.75);
      return { width: m, height: m };
    },
    aspectRatio: 1.0,
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }
  };

  qr.start({ facingMode: 'environment' }, cfg, aoLerQR, function () { /* falhas de frame: ignorar */ })
    .then(function () {
      estado.scanAtivo = true;
      $('btnScanStart').classList.add('hidden');
      $('btnScanStop').classList.remove('hidden');
      $('scanHint').textContent = 'Aponte a câmera para o QR Code do item';
    })
    .catch(function (err) {
      $('scanHint').textContent = 'Não foi possível abrir a câmera.';
      toast('Câmera: ' + (err && err.message ? err.message : err), 'err');
    });
}

var ultimoCodigo = '', ultimoTs = 0;
function aoLerQR(texto) {
  var agora = Date.now();
  if (texto === ultimoCodigo && agora - ultimoTs < 2500) return;
  ultimoCodigo = texto; ultimoTs = agora;
  vibrar(70);
  bip(1200, 0.08);
  pararScanner();
  abrirItem(texto);
}

function pararScanner() {
  if (!qr || !estado.scanAtivo) return;
  estado.scanAtivo = false;
  $('btnScanStart').classList.remove('hidden');
  $('btnScanStop').classList.add('hidden');
  try { qr.stop().catch(function () {}); } catch (e) {}
}

/* ---------------------------------------------------------
   IMPORTAÇÃO CSV
--------------------------------------------------------- */
function parseCSV(texto) {
  texto = texto.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  var primeiraLinha = texto.split('\n')[0] || '';
  var sep = (primeiraLinha.split(';').length > primeiraLinha.split(',').length) ? ';' :
            ((primeiraLinha.split('\t').length > primeiraLinha.split(',').length) ? '\t' : ',');
  var linhas = [], campo = '', linha = [], dentro = false;
  for (var i = 0; i < texto.length; i++) {
    var c = texto[i];
    if (dentro) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
      else campo += c;
    } else {
      if (c === '"') dentro = true;
      else if (c === sep) { linha.push(campo); campo = ''; }
      else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
      else campo += c;
    }
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter(function (l) { return l.some(function (x) { return String(x).trim() !== ''; }); });
}

function acharCol(cabec, nomes) {
  for (var i = 0; i < cabec.length; i++) {
    var h = cabec[i].trim().toLowerCase().replace(/[áàâã]/g, 'a').replace(/[éê]/g, 'e')
             .replace(/í/g, 'i').replace(/[óôõ]/g, 'o').replace(/ú/g, 'u').replace(/ç/g, 'c');
    for (var j = 0; j < nomes.length; j++) if (h === nomes[j]) return i;
  }
  return -1;
}

function importarCSV(texto) {
  var linhas = parseCSV(texto);
  if (!linhas.length) { toast('Arquivo vazio', 'err'); return; }

  var cabec = linhas[0];
  var iCod = acharCol(cabec, ['codigo', 'code', 'cod', 'sku', 'payload', 'serial']);
  var temCabec = iCod > -1;
  var iNome, iDesc, iUn, iSal, iMin;

  if (temCabec) {
    iNome = acharCol(cabec, ['nome', 'descricao_item', 'item', 'produto', 'componente']);
    iDesc = acharCol(cabec, ['descricao', 'desc', 'observacao', 'detalhe']);
    iUn   = acharCol(cabec, ['unidade_medida', 'unidade', 'un', 'um', 'medida']);
    iSal  = acharCol(cabec, ['estoque_atual', 'estoque', 'saldo', 'quantidade', 'qtd', 'qtde']);
    iMin  = acharCol(cabec, ['estoque_minimo', 'minimo', 'min', 'estoque_min']);
    linhas = linhas.slice(1);
  } else {
    iCod = 0; iNome = 1; iDesc = 2; iUn = 3; iSal = 4; iMin = 5;
  }
  if (iNome === -1) iNome = (iCod === 0 ? 1 : 0);

  var novos = 0, atualizados = 0, ignorados = 0;
  var paraNuvem = [];
  var atualizaSaldo = $('csvAtualizaSaldo').checked;
  var v = function (l, i) { return (i > -1 && i < l.length) ? String(l[i]).trim() : ''; };

  db.run('BEGIN');
  try {
    for (var k = 0; k < linhas.length; k++) {
      var l = linhas[k];
      var cod = v(l, iCod);
      if (!cod) { ignorados++; continue; }
      var nome = v(l, iNome) || cod;
      var desc = v(l, iDesc) || null;
      var un = (v(l, iUn) || 'UN').toUpperCase();
      var saldo = iSal > -1 ? parseNum(v(l, iSal)) : 0;
      var min = iMin > -1 ? parseNum(v(l, iMin)) : 0;

      paraNuvem.push({ codigo: cod, nome: nome, descricao: desc, unidade_medida: un,
                       estoque_atual: saldo, estoque_minimo: min });

      var existe = um('SELECT codigo FROM itens WHERE codigo=$c', { $c: cod });
      if (existe) {
        if (atualizaSaldo) {
          db.run('UPDATE itens SET nome=?,descricao=?,unidade_medida=?,estoque_atual=?,estoque_minimo=? WHERE codigo=?',
            [nome, desc, un, saldo, min, cod]);
        } else {
          db.run('UPDATE itens SET nome=?,descricao=?,unidade_medida=?,estoque_minimo=? WHERE codigo=?',
            [nome, desc, un, min, cod]);
        }
        atualizados++;
      } else {
        db.run('INSERT INTO itens (codigo,nome,descricao,unidade_medida,estoque_atual,estoque_minimo,data_cadastro) VALUES (?,?,?,?,?,?,?)',
          [cod, nome, desc, un, saldo, min, agoraISO()]);
        novos++;
      }
    }
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (e2) {}
    toast('Erro na importação: ' + e.message, 'err');
    return;
  }

  salvar(true);
  $('csvResultado').innerHTML = '✅ <b>' + novos + '</b> novos • <b>' + atualizados +
    '</b> atualizados' + (ignorados ? ' • ' + ignorados + ' ignorados' : '');
  toast('Importação concluída: ' + novos + ' novos', 'ok');
  atualizarStats();

  if (Nuvem.ativa() && paraNuvem.length) {
    $('csvResultado').innerHTML += ' • enviando para a nuvem...';
    Nuvem.enviarItens(paraNuvem, atualizaSaldo).then(function () {
      $('csvResultado').innerHTML = '✅ <b>' + paraNuvem.length + '</b> itens enviados para a nuvem';
      toast('Catálogo publicado na nuvem', 'ok');
      return sincronizar(true);
    }).catch(function (e) {
      $('csvResultado').innerHTML = '⚠️ Importado só neste aparelho — a nuvem recusou: ' + esc(e.message);
      toast('Não subiu para a nuvem: ' + e.message, 'err');
    });
  }
}

/* ---------------------------------------------------------
   EXPORTAÇÃO
--------------------------------------------------------- */
/* Lê um arquivo de texto (CSV) adivinhando a codificação.
   Excel do Windows salva CSV em ANSI (windows-1252): lido como UTF-8
   os acentos viram lixo. Tentamos UTF-8 estrito e, se falhar, 1252. */
/* "JoÃ£o" -> "João": texto UTF-8 que já foi salvo como 1252.
   É UTF-8 válido, então só dá pra corrigir olhando o padrão. */
function repararMojibake(s) {
  if (!/[\u00C3\u00C2][\u0080-\u00BF]/.test(s)) return s;
  try {
    var bytes = new Uint8Array(s.length), i;
    for (i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c > 255) return s;
      bytes[i] = c;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) { return s; }
}
function lerTexto(file, cb) {
  var fr = new FileReader();
  fr.onload = function () {
    var buf = new Uint8Array(fr.result), txt;
    try {
      txt = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      try { txt = new TextDecoder('windows-1252').decode(buf); }
      catch (e2) { txt = new TextDecoder('utf-8').decode(buf); }
    }
    cb(repararMojibake(txt.replace(/^﻿/, '')));
  };
  fr.readAsArrayBuffer(file);
}
function baixar(blob, nome) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
}
function carimbo() {
  var d = new Date(), p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
}
function exportarDB() {
  try {
    baixar(new Blob([db.export()], { type: 'application/x-sqlite3' }), 'almoxarifado_' + carimbo() + '.db');
    toast('Arquivo .db gerado (pasta Downloads)', 'ok');
  } catch (e) { toast('Erro ao exportar: ' + e.message, 'err'); }
}
function csvDe(colunas, linhas) {
  var q = function (x) {
    var s = (x == null ? '' : String(x));
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var out = [colunas.join(';')];
  linhas.forEach(function (r) { out.push(colunas.map(function (c) { return q(r[c]); }).join(';')); });
  return '﻿' + out.join('\r\n');
}
function exportarItensCSV() {
  var cols = ['codigo', 'nome', 'descricao', 'unidade_medida', 'estoque_atual', 'estoque_minimo', 'data_cadastro'];
  var txt = csvDe(cols, sel('SELECT ' + cols.join(',') + ' FROM itens ORDER BY codigo'));
  baixar(new Blob([txt], { type: 'text/csv;charset=utf-8' }), 'itens_' + carimbo() + '.csv');
  toast('CSV de itens gerado', 'ok');
}
function exportarMovCSV() {
  var cols = ['id', 'codigo_item', 'tipo', 'quantidade', 'data_hora', 'usuario', 'observacao'];
  var txt = csvDe(cols, sel('SELECT ' + cols.join(',') + ' FROM movimentacoes ORDER BY id'));
  baixar(new Blob([txt], { type: 'text/csv;charset=utf-8' }), 'movimentacoes_' + carimbo() + '.csv');
  toast('CSV de movimentações gerado', 'ok');
}
function importarDB(buffer) {
  try {
    var novo = new SQL.Database(new Uint8Array(buffer));
    novo.run(SCHEMA);
    novo.exec('SELECT COUNT(*) FROM itens');
    db.close();
    db = novo;
    salvar(true);
    toast('Banco importado com sucesso', 'ok');
    mostrarView('estoque');
  } catch (e) { toast('Arquivo inválido: ' + e.message, 'err'); }
}

/* ---------------------------------------------------------
   STATS / RODAPÉ
--------------------------------------------------------- */
function pintarConfigNuvem() {
  var ok = Nuvem.ativa();
  $('nuvemAparelho').textContent = Nuvem.aparelho();
  $('nuvemServidor').textContent = ok ? Nuvem.servidor() : '-';
  $('nuvemAviso').textContent = ok
    ? 'Este aparelho usa o banco oficial do almoxarifado, definido no cofre do app. Não há nada para configurar aqui.'
    : 'Nenhum banco definido no cofre deste app. Gere o cofre em admin.html com a URL e a chave do Supabase.';
  $('btnNuvemSync').classList.toggle('hidden', !ok);
  $('btnNuvemEnviar').classList.toggle('hidden', !ok);
  atualizarStatusNuvem();
}

function atualizarStats() {
  var ni = escalar('SELECT COUNT(*) FROM itens');
  var nm = escalar('SELECT COUNT(*) FROM movimentacoes');
  $('statItens').textContent = ni;
  $('statMov').textContent = nm;
  $('appVersao').textContent = APP_VERSION;
  $('statSalvo').textContent = fmtDataHora(localStorage.getItem('ultimo_salvamento')) || '-';
  $('topSub').textContent = ni + ' itens • ' + nm + ' movimentações';
  $('operadorLabel').textContent = Auth.atual()
    ? ('👤 ' + Auth.usuario())
    : (operador() || 'definir operador');

  var hu = $('hubUser');
  if (hu) hu.textContent = Auth.atual() ? ('👤 ' + Auth.usuario()) : (operador() || 'operador');
  var hv = $('hubVersao');
  if (hv) hv.textContent = APP_VERSION;
}

/* ---------------------------------------------------------
   EVENTOS
--------------------------------------------------------- */
function ligarEventos() {
  qsa('.tab').forEach(function (t) {
    t.addEventListener('click', function () { mostrarView(t.dataset.view); });
  });

  /* voltar do módulo para o hub de funções */
  $('btnVoltarHub').addEventListener('click', mostrarHub);

  /* conta / trocar operador a partir do hub */
  $('btnHubConta').addEventListener('click', function () { $('btnOperador').click(); });
  $('hubNuvemDot').addEventListener('click', function () {
    if (!Nuvem.ativa()) { toast('Banco da nuvem não vem no cofre deste app', 'err'); return; }
    sincronizar(false);
  });

  $('btnOperador').addEventListener('click', function () {
    if (Auth.atual()) {
      if (!confirm('Sair da conta de ' + Auth.usuario() + '?\n\n' +
                   'O estoque continua salvo neste aparelho, mas será preciso ' +
                   'entrar de novo para usar o app.')) return;
      Auth.sair();
      location.reload();
      return;
    }
    var n = prompt('Nome do operador (aparece no histórico):', operador());
    if (n !== null) { localStorage.setItem('operador', n.trim()); atualizarStats(); }
  });

  /* nuvem */
  $('nuvemDot').addEventListener('click', function () {
    if (!Nuvem.ativa()) { mostrarView('dados'); toast('Banco da nuvem não vem no cofre deste app', 'err'); return; }
    sincronizar(false);
  });

  $('btnNuvemSync').addEventListener('click', function () { sincronizar(false); });

  $('btnNuvemEnviar').addEventListener('click', function () {
    if (!Nuvem.ativa()) { toast('Nuvem indisponível: faça login no cofre', 'err'); return; }
    var lista = sel('SELECT codigo,nome,descricao,unidade_medida,estoque_atual,estoque_minimo FROM itens ORDER BY codigo');
    if (!lista.length) { toast('Nenhum item para enviar', 'err'); return; }
    if (!confirm('Enviar ' + lista.length + ' itens deste aparelho para a nuvem?\n\nItens que já existem lá NÃO são alterados.')) return;
    nuvemStatus('Enviando...', 'sync');
    Nuvem.enviarItens(lista, false).then(function () {
      toast('Itens enviados', 'ok');
      return sincronizar(false);
    }).catch(function (e) {
      atualizarStatusNuvem();
      toast('Falha ao enviar: ' + e.message, 'err');
    });
  });

  /* estoque */
  var tBusca = null;
  $('buscaEstoque').addEventListener('input', function () {
    clearTimeout(tBusca); tBusca = setTimeout(renderEstoque, 180);
  });
  $('btnLimpaBusca').addEventListener('click', function () {
    $('buscaEstoque').value = ''; renderEstoque();
  });
  qsa('[data-estoquefiltro]').forEach(function (b) {
    b.addEventListener('click', function () {
      estado.filtroEstoque = b.dataset.estoquefiltro;
      qsa('[data-estoquefiltro]').forEach(function (x) { x.classList.toggle('active', x === b); });
      renderEstoque();
    });
  });

  /* scan */
  $('btnScanStart').addEventListener('click', iniciarScanner);
  $('btnScanStop').addEventListener('click', pararScanner);
  $('btnBuscarManual').addEventListener('click', function () {
    var c = $('codigoManual').value.trim();
    if (!c) { toast('Digite um código', 'err'); return; }
    $('codigoManual').value = '';
    abrirItem(c);
  });
  $('codigoManual').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btnBuscarManual').click();
  });

  /* item */
  $('btnVoltarItem').addEventListener('click', function () { mostrarView('estoque'); });
  $('btnEntrada').addEventListener('click', function () { abrirMov('ENTRADA'); });
  $('btnSaida').addEventListener('click', function () { abrirMov('SAIDA'); });
  $('btnEditarItem').addEventListener('click', function () { abrirCadastro(estado.itemAtual); });

  /* histórico */
  var tH = null;
  $('buscaHist').addEventListener('input', function () {
    clearTimeout(tH); tH = setTimeout(renderHistorico, 180);
  });
  qsa('[data-histtipo]').forEach(function (b) {
    b.addEventListener('click', function () {
      estado.histTipo = b.dataset.histtipo;
      qsa('[data-histtipo]').forEach(function (x) { x.classList.toggle('active', x === b); });
      renderHistorico();
    });
  });
  qsa('[data-histper]').forEach(function (b) {
    b.addEventListener('click', function () {
      estado.histPeriodo = Number(b.dataset.histper);
      qsa('[data-histper]').forEach(function (x) { x.classList.toggle('active', x === b); });
      renderHistorico();
    });
  });

  /* sheet movimentação */
  $('movQtd').addEventListener('input', atualizarPrevia);
  qsa('[data-qty]').forEach(function (b) {
    b.addEventListener('click', function () {
      var atual = parseNum($('movQtd').value) + Number(b.dataset.qty);
      if (atual < 0) atual = 0;
      $('movQtd').value = fmtNum(atual).replace(',', '.');
      atualizarPrevia();
    });
  });
  qsa('[data-setqty]').forEach(function (b) {
    b.addEventListener('click', function () { $('movQtd').value = b.dataset.setqty; atualizarPrevia(); });
  });
  $('btnMovCancelar').addEventListener('click', fecharSheets);
  $('btnMovConfirmar').addEventListener('click', confirmarMov);

  /* sheet cadastro */
  $('btnNovoItem').addEventListener('click', function () { abrirCadastro(null, ''); });
  $('btnCadCancelar').addEventListener('click', fecharSheets);
  $('btnCadSalvar').addEventListener('click', salvarCadastro);

  qsa('.sheet-wrap').forEach(function (w) {
    w.addEventListener('click', function (e) { if (e.target === w) fecharSheets(); });
  });

  /* dados */
  $('btnEscolherCsv').addEventListener('click', function () { $('fileCsv').click(); });
  $('fileCsv').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    lerTexto(f, function (txt) { importarCSV(txt); e.target.value = ''; });
  });
  $('btnEscolherDb').addEventListener('click', function () { $('fileDb').click(); });
  $('fileDb').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    if (!confirm('Isso substitui TODOS os dados deste aparelho. Continuar?')) { e.target.value = ''; return; }
    var r = new FileReader();
    r.onload = function () { importarDB(r.result); e.target.value = ''; };
    r.readAsArrayBuffer(f);
  });
  $('btnExportDb').addEventListener('click', exportarDB);
  $('btnExportCsvItens').addEventListener('click', exportarItensCSV);
  $('btnExportCsvMov').addEventListener('click', exportarMovCSV);
  $('btnExcluirItem').addEventListener('click', function () {
    var btn = $('btnExcluirItem');
    var codigo = normalizarCodigo($('excluirCodigo').value || '');
    if (!codigo) { toast('Informe o código do item', 'err'); return; }

    var it = buscarItem(codigo);
    var nome = it ? it.nome : '(não existe neste aparelho)';
    if (it) codigo = it.codigo;

    var mov = um('SELECT COUNT(*) c FROM movimentacoes WHERE codigo_item=$c', { $c: codigo });
    var qtd = mov ? Number(mov.c) || 0 : 0;

    if (!confirm('Excluir ' + codigo + ' — ' + nome + '?\n\n'
      + 'Apaga o item e ' + qtd + ' movimentaç' + (qtd === 1 ? 'ão' : 'ões')
      + (Nuvem.ativa() ? ' deste aparelho E DA NUVEM (todos os celulares).' : ' deste aparelho.'))) return;
    if (!confirm('Tem certeza? Esta ação não pode ser desfeita.')) return;

    function apagarLocal() {
      db.run('DELETE FROM movimentacoes WHERE codigo_item=$c', { $c: codigo });
      db.run('DELETE FROM itens WHERE codigo=$c', { $c: codigo });
      salvar(true);
      renderEstoque(); atualizarStats();
      if (estado.itemAtual && estado.itemAtual.codigo === codigo) { estado.itemAtual = null; fecharSheets(); }
      $('excluirCodigo').value = '';
    }

    if (!Nuvem.ativa()) { apagarLocal(); toast('Item ' + codigo + ' excluído', 'ok'); return; }

    btn.disabled = true;
    nuvemStatus('Excluindo na nuvem...', 'sync');
    Nuvem.excluirItem(codigo, operador()).then(function (r) {
      apagarLocal();
      toast('Item ' + codigo + ' excluído da nuvem (' + (Number(r.movimentacoes) || 0) + ' mov.)', 'ok');
      atualizarStatusNuvem();
    }).catch(function (e) {
      atualizarStatusNuvem();
      if (/nao existe/i.test(e.message)) {
        apagarLocal();
        toast('Item não estava na nuvem; apagado deste aparelho', 'ok');
        return;
      }
      toast('Não excluiu: ' + e.message, 'err');
    }).then(function () { btn.disabled = false; });
  });

  $('btnZerar').addEventListener('click', function () {
    var aviso = Nuvem.ativa()
      ? 'Apagar os dados DESTE APARELHO?\n\nA nuvem NÃO é apagada — na próxima sincronização tudo volta.'
      : 'Apagar TODOS os itens e movimentações deste aparelho?';
    if (!confirm(aviso)) return;
    if (!confirm('Tem certeza? Exporte o backup antes. Esta ação não pode ser desfeita.')) return;
    db.run('DELETE FROM movimentacoes; DELETE FROM itens; DELETE FROM sqlite_sequence WHERE name="movimentacoes";');
    salvar(true);
    toast('Dados apagados', 'ok');
    renderEstoque(); atualizarStats();
  });
  $('btnAtualizar').addEventListener('click', function () {
    if (!navigator.serviceWorker) { location.reload(); return; }
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) { location.reload(); return; }
      toast('Procurando atualização...');
      reg.update().then(function () { setTimeout(function () { location.reload(true); }, 900); });
    });
  });

  /* botão voltar do Android fecha sheets */
  window.addEventListener('popstate', function () {
    if ($('sheetMov').classList.contains('open') || $('sheetItem').classList.contains('open')) fecharSheets();
    history.pushState(null, '', location.href);
  });
  history.pushState(null, '', location.href);

  /* instalação PWA */
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    $('btnInstalar').classList.remove('hidden');
  });
  $('btnInstalar').addEventListener('click', function () {
    if (!deferred) { toast('Use o menu do Chrome → "Adicionar à tela inicial"'); return; }
    deferred.prompt();
    deferred.userChoice.then(function () { deferred = null; $('btnInstalar').classList.add('hidden'); });
  });

  /* segurança: salva ao sair; ao voltar, busca o que mudou na nuvem */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { pararScanner(); salvar(true); }
    else sincronizar(true);
  });

  /* reconectou o sinal -> puxa o estoque atualizado */
  window.addEventListener('online', function () { sincronizar(true); });
  window.addEventListener('offline', atualizarStatusNuvem);
}

/* ---------------------------------------------------------
   SERVICE WORKER
--------------------------------------------------------- */
function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then(function (reg) {
    reg.addEventListener('updatefound', function () {
      var novo = reg.installing;
      if (!novo) return;
      novo.addEventListener('statechange', function () {
        if (novo.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Nova versão disponível — recarregando...');
          novo.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
  }).catch(function () {});
  var recarregou = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (recarregou) return;
    recarregou = true;
    location.reload();
  });
}

/* ---------------------------------------------------------
   LOGIN
--------------------------------------------------------- */
function abrirLogin() {
  $('hub').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('loginUser').focus();
}

function erroLogin(msg) {
  var e = $('loginErro');
  e.textContent = msg || '';
  e.classList.toggle('hidden', !msg);
}

/* depois do login (ou quando não há cofre) o app sobe de verdade */
function entrarNoApp() {
  $('login').classList.add('hidden');
  Nuvem.carregar();
  pintarConfigNuvem();
  atualizarStats();
  renderEstoque();
  sincronizar(true);

  /* depois de logar o app cai no hub de funções */
  mostrarHub();

  // atalho do ícone do app: abrir direto no scanner do almoxarifado
  try {
    if (new URLSearchParams(location.search).get('acao') === 'scan') {
      abrirModulo('almox');
      mostrarView('scan');
    }
  } catch (e) {}
}

function ligarLogin() {
  $('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('btnEntrar');
    var u = $('loginUser').value.trim();
    var s = $('loginSenha').value;
    if (!u || !s) { erroLogin('Informe usuário e senha.'); return; }

    erroLogin('');
    btn.disabled = true;
    btn.textContent = 'Entrando...';

    /* PBKDF2 trava a tela por um instante; deixa o navegador pintar antes */
    setTimeout(function () {
      Auth.entrar(u, s, $('loginLembrar').checked)
        .then(function () {
          $('loginSenha').value = '';
          atualizarStats();
          entrarNoApp();
        })
        .catch(function (e) {
          erroLogin(e.message);
          vibrar([60, 50, 60]);
          $('loginSenha').value = '';
          $('loginSenha').focus();
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = 'Entrar';
        });
    }, 30);
  });
}

/* ---------------------------------------------------------
   BOOT
--------------------------------------------------------- */
iniciarSQL().then(function () {
  ligarEventos();
  ligarLogin();
  $('splash').classList.add('hide');
  registrarSW();

  /* Sem cofre publicado (js/usuarios.js vazio) o app segue como antes:
     sem login, com a nuvem configurada na mão em cada aparelho. */
  if (Auth.temCofre() && !Auth.restaurar()) { abrirLogin(); return; }
  entrarNoApp();
}).catch(function (e) {
  $('splash').innerHTML = '<div style="padding:24px;text-align:center;color:#ff6b6b">' +
    'Falha ao iniciar o banco de dados.<br><small>' + esc(e && e.message) + '</small></div>';
});

})();
