/* =========================================================
   Controle PCP LION - MÓDULO KITS

   Separação de kits por máquina. A planilha "PROGRAMACAO DIARIA
   OPERACIONAL" (Google Sheets) é espelhada no Supabase por um
   Apps Script (apps-script/kits-sync.gs); o app lê o espelho
   (kits_linhas) e grava pedidos na fila (RPC kits_separar).

   - Uma aba da planilha por semana ("2ª SEM NOV"). Cada linha é
     uma máquina de uma carga, com duas colunas que importam:
     KIT (liberado pelo PCP) e ALMOX. FRENTE (já separado).
   - O app só pede TRUE em ALMOX. FRENTE, e só em kit liberado.
     Quem garante isso é a RPC kits_separar e o Apps Script; aqui
     só respeitamos.
   - Falta de componente de um kit vira uma falta normal do módulo
     Faltas (ModuloFaltas.registrarExterno), vinculada à linha do
     kit na tabela kits_faltas.
   - Histórico: tabela kits_historico (só leitura aqui; quem grava
     é Nuvem.kitsSeparar).

   Mesma forma pública do ModuloFaltas: obter(cfg) devolve a
   instância (preparar, aoMostrarView, fecharSheets) e o objeto
   também expõe aoMostrarView(nome) para todas as instâncias.
   Cota da planilha: 60 leituras/min/usuário, então NÃO há polling
   automático; a leitura de cada aba fica em cache por 20 s.
   ========================================================= */
window.ModuloKits = (function () {
  'use strict';

  var CACHE_MS = 20000;          /* leitura de uma aba */
  var CACHE_ABAS_MS = 300000;    /* lista de abas (muda raramente) */
  var SYNC_ATRASADA_MS = 600000; /* espelho sem sincronizar ha mais de 10 min = aviso */

  var MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];

  /* estados derivados de KIT + ALMOX. FRENTE; a ordem é a ordem na lista */
  var ESTADOS = [
    { cod: 'liberado',   label: 'Liberado',   ordem: 0 },
    { cod: 'aguardando', label: 'Aguardando', ordem: 1 },
    { cod: 'separado',   label: 'Separado',   ordem: 2 }
  ];

  /* =========================================================
     LÓGICA PURA (sem DOM, sem rede) - exposta em _testes
     ========================================================= */
  function semAcento(s) {
    var t = String(s == null ? '' : s);
    if (t.normalize) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return t;
  }

  function norm(s) {
    return semAcento(s).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function labelEstado(cod) {
    for (var i = 0; i < ESTADOS.length; i++) if (ESTADOS[i].cod === cod) return ESTADOS[i].label;
    return 'Aguardando';
  }
  function ordemEstado(cod) {
    for (var i = 0; i < ESTADOS.length; i++) if (ESTADOS[i].cod === cod) return ESTADOS[i].ordem;
    return 9;
  }

  /* kit separado = ALMOX. FRENTE marcado (mesmo sem KIT: já está na frente);
     liberado = KIT marcado e ainda não separado; senão aguardando */
  function derivarEstado(l) {
    if (!l) return 'aguardando';
    if (l.almoxFrente === true) return 'separado';
    if (l.kit === true) return 'liberado';
    return 'aguardando';
  }

  /* "2ª SEM NOV" -> { nome, semana: 2, mes: 'NOV', mesNum: 11 }
     nome fora do padrão -> semana 0, mesNum 99 (vai para o fim) */
  function parseAba(nome) {
    var n = String(nome == null ? '' : nome).trim();
    var m = /^(\d+)\s*[^\s\d]*\s+SEM\s+(\S+)\s*$/i.exec(n);
    if (!m) return { nome: n, semana: 0, mes: '', mesNum: 99 };
    var mes = semAcento(m[2]).toUpperCase().slice(0, 3);
    var idx = MESES.indexOf(mes);
    return { nome: n, semana: parseInt(m[1], 10), mes: mes, mesNum: idx < 0 ? 99 : idx + 1 };
  }

  /* ordem cronológica dentro do ano: mês e depois semana */
  function ordenarAbas(abas) {
    var lista = (abas || []).map(function (a, i) {
      var p = parseAba(a);
      p.pos = i;
      return p;
    });
    lista.sort(function (a, b) {
      if (a.mesNum !== b.mesNum) return a.mesNum - b.mesNum;
      if (a.semana !== b.semana) return a.semana - b.semana;
      return a.pos - b.pos;
    });
    return lista.map(function (p) { return p.nome; });
  }

  /* aba aberta por padrão: a semana de hoje; sem ela, a última semana
     já começada no mês; sem mês, a última da lista */
  function abaPadrao(abas, hoje) {
    var lista = abas || [];
    if (!lista.length) return '';
    var d = hoje || new Date();
    var mes = d.getMonth() + 1;
    var sem = Math.ceil(d.getDate() / 7);
    var doMes = [];
    for (var i = 0; i < lista.length; i++) {
      var p = parseAba(lista[i]);
      if (p.mesNum === mes) doMes.push(p);
    }
    if (doMes.length) {
      var melhor = null;
      for (var j = 0; j < doMes.length; j++) {
        if (doMes[j].semana <= sem && (!melhor || doMes[j].semana > melhor.semana)) melhor = doMes[j];
      }
      if (!melhor) {
        melhor = doMes[0];
        for (var k = 1; k < doMes.length; k++) if (doMes[k].semana < melhor.semana) melhor = doMes[k];
      }
      return melhor.nome;
    }
    var ord = ordenarAbas(lista);
    return ord[ord.length - 1];
  }

  /* acrescenta estado e a numeração dos repetidos (mesma carga + produto:
     3 máquinas iguais viram 1/3, 2/3, 3/3, na ordem da planilha) */
  /* mesma regra do Apps Script (kits-sync.gs): so maquina com codigo; fora TOTAL e
     LOGOTIPO; excecao BANCO MULTIFUNCIONAL na carga LOJA. Defesa para o caso
     de a funcao publicada ser uma versao antiga. */
  function ehMaquina(l) {
    var p = semAcento(String((l && l.produto) == null ? '' : l.produto))
      .replace(/\s+/g, ' ').trim().toUpperCase();
    var c = semAcento(String((l && l.carga) == null ? '' : l.carga))
      .replace(/\s+/g, ' ').trim().toUpperCase();
    if (!p) return false;
    if (p.indexOf('TOTAL DE') === 0 || p.indexOf('LOGOTIPO') >= 0) return false;
    if (/\d+\s*-\s*\S/.test(p)) return true;
    return p.indexOf('BANCO') >= 0 && p.indexOf('MULTIFUNCIONAL') >= 0 && c === 'LOJA';
  }

  /* destaque visual: nome com "anilheiro" ou variações próximas (anilheira, anilhero...) */
  function htmlNomeMaquina(produto) {
    var seguro = String(produto == null ? '' : produto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return seguro.replace(/anil+h?e+i?r[a-z]*/gi, function (m) {
      return '<span class="kit-anilheiro">' + m + '</span>';
    });
  }

  function decorar(linhas) {
    var lista = (linhas || []).filter(ehMaquina).map(function (l) {
      return {
        linha: l.linha,
        carga: String(l.carga == null ? '' : l.carga).trim(),
        produto: String(l.produto == null ? '' : l.produto).trim(),
        almoxFrente: l.almoxFrente === true,
        kit: l.kit === true,
        estado: derivarEstado(l),
        seq: 1,
        total: 1
      };
    });
    var cont = {}, vistos = {};
    lista.forEach(function (l) {
      var k = norm(l.carga) + '|' + norm(l.produto);
      cont[k] = (cont[k] || 0) + 1;
    });
    lista.forEach(function (l) {
      var k = norm(l.carga) + '|' + norm(l.produto);
      vistos[k] = (vistos[k] || 0) + 1;
      l.seq = vistos[k];
      l.total = cont[k];
    });
    return lista;
  }

  function contar(linhas) {
    var c = { total: 0, liberado: 0, aguardando: 0, separado: 0 };
    (linhas || []).forEach(function (l) {
      c.total++;
      var e = l.estado || derivarEstado(l);
      if (c[e] !== undefined) c[e]++;
    });
    return c;
  }

  /* f.estado ('' = todos) e f.busca (carga ou produto, sem acento) */
  function filtrar(linhas, f) {
    var o = f || {};
    var est = o.estado || '';
    var q = norm(o.busca || '');
    return (linhas || []).filter(function (l) {
      if (est && (l.estado || derivarEstado(l)) !== est) return false;
      if (q && norm(l.carga + ' ' + l.produto).indexOf(q) === -1) return false;
      return true;
    });
  }

  /* grupos por carga na ordem em que aparecem; dentro do grupo, liberados
     primeiro (o que há para fazer), depois aguardando, depois separados.
     Os totais do grupo vêm de "todas" (lista sem filtro), para o contador
     "2/5 separados" não mudar com o filtro. */
  function agruparPorCarga(itens, todas) {
    var grupos = [], porCarga = {};
    (itens || []).forEach(function (l) {
      var nome = l.carga || 'Sem carga';
      var k = norm(nome);
      if (!porCarga[k]) {
        porCarga[k] = { carga: nome, itens: [], separados: 0, total: 0 };
        grupos.push(porCarga[k]);
      }
      porCarga[k].itens.push(l);
    });
    var base = {};
    (todas || itens || []).forEach(function (l) {
      var k = norm(l.carga || 'Sem carga');
      if (!base[k]) base[k] = { separados: 0, total: 0 };
      base[k].total++;
      if ((l.estado || derivarEstado(l)) === 'separado') base[k].separados++;
    });
    grupos.forEach(function (g) {
      var b = base[norm(g.carga)] || { separados: 0, total: g.itens.length };
      g.separados = b.separados;
      g.total = b.total;
      g.itens.sort(function (a, b2) {
        var d = ordemEstado(a.estado) - ordemEstado(b2.estado);
        return d !== 0 ? d : (a.linha - b2.linha);
      });
    });
    return grupos;
  }

  /* faltas vinculadas: { linha: [falta, ...] }, só as que ainda batem
     com o produto da linha (a planilha pode ter mudado) */
  function agruparFaltas(faltas, linhas) {
    var porLinha = {}, mapa = {};
    (linhas || []).forEach(function (l) { mapa[l.linha] = l; });
    (faltas || []).forEach(function (f) {
      var l = mapa[f.linha];
      if (!l) return;
      if (norm(f.produto) !== norm(l.produto)) return;
      /* falta suprida no módulo Faltas deixa de aparecer no kit */
      if (f.suprida_em) return;
      if (!porLinha[f.linha]) porLinha[f.linha] = [];
      porLinha[f.linha].push(f);
    });
    return porLinha;
  }

  /* quantidade faltante para exibir: 2 -> "2", 1.5 -> "1,5"; vazio se não houver */
  function fmtQtd(q) {
    var n = Number(q);
    if (q == null || q === '' || !isFinite(n)) return '';
    return String(n).replace('.', ',');
  }

  function cacheValido(t, agora, ms) {
    return typeof t === 'number' && (agora - t) >= 0 && (agora - t) < ms;
  }

  /* erro da nuvem/função -> texto para o toast */
  function msgErro(e) {
    var st = e && e.status;
    var m = String((e && e.message) || '');
    if (m === 'Nuvem nao configurada') return 'Nuvem não configurada neste aparelho';
    if (st === 429) return 'Limite de leituras da planilha atingido. Tente de novo em instantes.';
    if (st === 409) return m || 'A planilha mudou. Atualize a lista.';
    if (st === 500 || st === 502 || st === 401 || st === 403) return 'Planilha ainda não conectada';
    return m || 'Falha ao falar com a planilha';
  }

  function horaCurta(t) {
    var d = new Date(t);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* =========================================================
     A instância do módulo
     ========================================================= */
  function criarInstancia(cfg) {
    var P = window.PCP;
    var $ = P.$, qsa = P.qsa, esc = P.esc, toast = P.toast;

    var id = cfg.id;                    // 'kits'
    var montado = false;
    var estado = {
      abas: [], abasT: 0, aba: '',
      linhas: null, faltas: {}, t: 0, sync: 0,
      filtro: '', busca: '',
      carregando: false, promessa: null, erro: '',
      alvo: null, ocupado: false, almFalta: 'frente', nomeAuto: false,
      hist: null, histT: 0, histBusca: '', histCarregando: false, histErro: ''
    };
    var cacheAba = {};
    var tDigita = null, tBusca = null;

    function nv() {
      if (!window.Nuvem) throw new Error('Nuvem nao configurada');
      return window.Nuvem;
    }
    function temAcesso() {
      var A = window.Auth;
      if (!A || !A.atual || !A.atual() || !A.podeVer) return true;
      return !!A.podeVer(id);
    }
    function podeEditar() {
      var A = window.Auth;
      if (!A || !A.podeEditar) return true;
      return !!A.podeEditar(id);
    }
    function operador() {
      try { return P.operador() || ''; } catch (e) { return ''; }
    }
    function buscarLinha(n) {
      var ls = estado.linhas || [];
      for (var i = 0; i < ls.length; i++) if (ls[i].linha === n) return ls[i];
      return null;
    }
    function faltasDe(l) {
      return (l && estado.faltas[l.linha]) || [];
    }

    /* ---------- leitura da planilha ---------- */
    function carregarAbas(forcar) {
      var agora = Date.now();
      if (!forcar && estado.abas.length && cacheValido(estado.abasT, agora, CACHE_ABAS_MS)) {
        return Promise.resolve(estado.abas);
      }
      return Promise.resolve().then(function () { return nv().kitsAbas(); }).then(function (abas) {
        estado.abasT = Date.now();
        return ordenarAbas(abas);
      });
    }

    function aplicarCache(e) {
      estado.linhas = e.linhas;
      estado.faltas = agruparFaltas(e.faltas, e.linhas);
      estado.t = e.t;
      estado.sync = e.sync || 0;
    }

    function lerAba(aba, forcar) {
      var c = cacheAba[aba];
      if (!forcar && c && cacheValido(c.t, Date.now(), CACHE_MS)) {
        aplicarCache(c);
        return Promise.resolve();
      }
      var N = nv();
      return Promise.all([
        N.kitsLer(aba),
        /* as faltas vinculadas são só um enfeite: se falharem, a lista segue */
        Promise.resolve().then(function () { return N.kitsFaltasDe(aba); }).then(null, function () { return null; })
      ]).then(function (r) {
        var dados = r[0] || {};
        var e = {
          t: Date.now(),
          sync: dados.sincronizadoEm || 0,
          linhas: decorar(dados.linhas || []),
          faltas: r[1] || (c ? c.faltas : [])
        };
        cacheAba[aba] = e;
        aplicarCache(e);
      });
    }

    function carregar(forcar) {
      if (!temAcesso()) { renderLista(); return Promise.resolve(); }
      if (estado.carregando) return estado.promessa;
      estado.carregando = true;
      estado.erro = '';
      renderLista();
      estado.promessa = carregarAbas(!!forcar).then(function (abas) {
        estado.abas = abas;
        if (!abas.length) {
          estado.aba = '';
          estado.linhas = null;
          estado.erro = 'Nenhuma aba de semana encontrada na planilha.';
          return null;
        }
        if (!estado.aba || abas.indexOf(estado.aba) < 0) estado.aba = abaPadrao(abas, new Date());
        return lerAba(estado.aba, !!forcar);
      })['catch'](function (e) {
        estado.erro = msgErro(e);
      }).then(function () {
        estado.carregando = false;
        renderLista();
        try { P.atualizarStatusNuvem(); } catch (e2) {}
      });
      return estado.promessa;
    }

    /* ---------- histórico ---------- */
    function carregarHistorico(forcar) {
      if (!temAcesso()) { renderHistorico(); return Promise.resolve(); }
      if (estado.histCarregando) return Promise.resolve();
      if (!forcar && estado.hist && cacheValido(estado.histT, Date.now(), CACHE_MS)) {
        renderHistorico();
        return Promise.resolve();
      }
      estado.histCarregando = true;
      estado.histErro = '';
      renderHistorico();
      return Promise.resolve().then(function () {
        return nv().kitsHistorico({ limite: 200 });
      }).then(function (lista) {
        estado.hist = lista || [];
        estado.histT = Date.now();
      })['catch'](function (e) {
        estado.histErro = msgErro(e);
      }).then(function () {
        estado.histCarregando = false;
        renderHistorico();
      });
    }

    /* =========================================================
       HTML do módulo
       ========================================================= */
    function montarUI() {
      if (montado) return;
      montado = true;

      var main = $('main');
      var wrap = document.createElement('div');
      wrap.innerHTML = [
        /* ---------- ABA 1: KITS ---------- */
        '<section id="view-' + id + '-lista" class="view" data-modulo="' + id + '">',
        '  <div class="kits-topo">',
        '    <select id="' + id + 'Aba" class="kits-select" aria-label="Aba da semana"></select>',
        '    <button id="' + id + 'Atualizar" class="pill" type="button">&#8635; Atualizar</button>',
        '  </div>',
        '  <div class="searchbar">',
        '    <input id="' + id + 'Busca" type="search" inputmode="search" placeholder="Buscar carga ou produto..." autocomplete="off">',
        '    <button id="' + id + 'LimpaBusca" class="icon-btn" type="button" aria-label="Limpar">&times;</button>',
        '  </div>',
        '  <div id="' + id + 'Filtros" class="filters"></div>',
        '  <div id="' + id + 'Status" class="muted small kits-status"></div>',
        '  <div id="' + id + 'Lista"></div>',
        '</section>',

        /* ---------- ABA 2: HISTÓRICO ---------- */
        '<section id="view-' + id + '-historico" class="view" data-modulo="' + id + '">',
        '  <div class="kits-topo">',
        '    <span class="muted small kits-status">Kits separados, do mais recente ao mais antigo</span>',
        '    <button id="' + id + 'HistAtualizar" class="pill" type="button">&#8635; Atualizar</button>',
        '  </div>',
        '  <div class="searchbar">',
        '    <input id="' + id + 'HistBusca" type="search" inputmode="search" placeholder="Buscar carga, produto ou usuário..." autocomplete="off">',
        '  </div>',
        '  <div id="' + id + 'HistLista" class="list"></div>',
        '</section>'
      ].join('\n');
      while (wrap.firstChild) main.appendChild(wrap.firstChild);

      /* barra de abas própria do módulo */
      var nav = document.createElement('nav');
      nav.className = 'tabbar hidden';
      nav.id = 'tabbar-' + id;
      nav.setAttribute('data-modulo', id);
      nav.innerHTML = [
        '<button class="tab active" data-view="' + id + '-lista" type="button"><span>&#9745;</span>Kits</button>',
        '<button class="tab" data-view="' + id + '-historico" type="button"><span>&#8634;</span>Histórico</button>'
      ].join('');
      document.body.appendChild(nav);

      /* sheets: detalhe do kit (com o formulário de falta) e confirmação */
      var sheets = document.createElement('div');
      sheets.innerHTML = [
        '<div id="' + id + 'SheetKit" class="sheet-wrap janela-pc" data-modulo="' + id + '">',
        '  <div class="sheet">',
        '    <div class="sheet-handle"></div>',
        '    <button class="janela-x" type="button" aria-label="Fechar">&times;</button>',
        '    <h3 id="' + id + 'DetTitulo">Kit</h3>',
        '    <div id="' + id + 'DetCorpo"></div>',
        '    <div id="' + id + 'DetAcoes" class="kit-det-acoes"></div>',
        '  </div>',
        '</div>',

        '<div id="' + id + 'SheetFalta" class="sheet-wrap janela-pc" data-modulo="' + id + '">',
        '  <div class="sheet">',
        '    <div class="sheet-handle"></div>',
        '    <button class="janela-x" type="button" aria-label="Fechar">&times;</button>',
        '    <h3>Registrar falta de componente</h3>',
        '    <p id="' + id + 'FaltaKit" class="muted small kit-falta-janela-kit"></p>',
        '    <div id="' + id + 'FaltaForm" class="kit-falta-form aberto">',
        '      <label class="lbl">Código do componente</label>',
        '      <input id="' + id + 'FCodigo" type="text" autocomplete="off" autocapitalize="characters" list="' + id + 'FLista" placeholder="Digite o código">',
        '      <datalist id="' + id + 'FLista"></datalist>',
        '      <label class="lbl">Nome</label>',
        '      <input id="' + id + 'FNome" type="text" autocomplete="off" placeholder="preenche sozinho pelo código">',
        '      <p id="' + id + 'FDica" class="muted small"></p>',
        '      <label class="lbl">Quantidade faltante</label>',
        '      <input id="' + id + 'FQtd" type="number" inputmode="decimal" min="1" step="1" value="1">',
        '      <label class="lbl">Almoxarifado</label>',
        '      <div id="' + id + 'FAlm" class="falta-alm-opts">',
        '        <button type="button" data-alm="frente" class="on">Frente</button>',
        '        <button type="button" data-alm="fundo">Fundo</button>',
        '      </div>',
        '      <div class="sheet-actions">',
        '        <button id="' + id + 'FCancela" class="btn ghost" type="button">Cancelar</button>',
        '        <button id="' + id + 'FSalvar" class="btn primary" type="button">Registrar falta</button>',
        '      </div>',
        '    </div>',
        '  </div>',
        '</div>',

        '<div id="' + id + 'SheetSep" class="sheet-wrap janela-pc" data-modulo="' + id + '">',
        '  <div class="sheet">',
        '    <div class="sheet-handle"></div>',
        '    <button class="janela-x" type="button" aria-label="Fechar">&times;</button>',
        '    <h3>Separar kit</h3>',
        '    <p id="' + id + 'SepTxt" class="muted"></p>',
        '    <p class="muted small">Isto marca ALMOX. FRENTE na planilha para todo mundo.</p>',
        '    <div class="sheet-actions">',
        '      <button id="' + id + 'SepCancela" class="btn ghost" type="button">Cancelar</button>',
        '      <button id="' + id + 'SepOk" class="btn primary" type="button">Separar</button>',
        '    </div>',
        '  </div>',
        '</div>'
      ].join('\n');
      while (sheets.firstChild) document.body.appendChild(sheets.firstChild);

      ligarEventos();
    }

    function fecharSheets() {
      var a = $(id + 'SheetKit'), b = $(id + 'SheetSep');
      if (a) a.classList.remove('open');
      if (b) b.classList.remove('open');
      fecharFormFalta();
    }

    function fecharFormFalta() {
      var f = $(id + 'SheetFalta');
      if (f) f.classList.remove('open');
    }

    /* =========================================================
       RENDER - lista
       ========================================================= */
    function vazio(txt) { return '<div class="vazio">' + esc(txt) + '</div>'; }

    function renderControles() {
      var sel = $(id + 'Aba');
      if (sel) {
        var chave = estado.abas.join('|') + '#' + estado.aba;
        if (sel.getAttribute('data-chave') !== chave) {
          sel.innerHTML = estado.abas.length ? estado.abas.map(function (a) {
            return '<option value="' + esc(a) + '"' + (a === estado.aba ? ' selected' : '') + '>' + esc(a) + '</option>';
          }).join('') : '<option value="">Sem abas</option>';
          sel.setAttribute('data-chave', chave);
        }
        sel.disabled = estado.carregando || !estado.abas.length;
      }

      var c = contar(estado.linhas || []);
      var fil = $(id + 'Filtros');
      if (fil) {
        var defs = [
          { cod: '', label: 'Todos', n: c.total },
          { cod: 'liberado', label: 'Liberados', n: c.liberado },
          { cod: 'aguardando', label: 'Aguardando', n: c.aguardando },
          { cod: 'separado', label: 'Separados', n: c.separado }
        ];
        fil.innerHTML = defs.map(function (d) {
          return '<button type="button" class="pill' + (estado.filtro === d.cod ? ' active' : '') +
            '" data-filtro="' + d.cod + '">' + d.label + ' (' + d.n + ')</button>';
        }).join('');
      }

      var st = $(id + 'Status');
      if (st) {
        var txt = '';
        if (estado.carregando) txt = 'Lendo a planilha...';
        else if (estado.erro && estado.linhas) txt = estado.erro + ' (mostrando a última leitura)';
        else if (estado.linhas && estado.sync) {
          txt = 'Planilha sincronizada às ' + horaCurta(estado.sync);
          if (Date.now() - estado.sync > SYNC_ATRASADA_MS) txt += ' (sincronização atrasada)';
        } else if (estado.linhas && estado.t) txt = 'Lido às ' + horaCurta(estado.t);
        st.textContent = txt;
        st.classList.toggle('kits-status-erro', !!(estado.erro && estado.linhas) ||
          !!(estado.sync && !estado.carregando && Date.now() - estado.sync > SYNC_ATRASADA_MS));
      }

      var at = $(id + 'Atualizar');
      if (at) at.disabled = estado.carregando;
    }

    function htmlLinha(l, pode) {
      var fs = faltasDe(l);
      var seq = l.total > 1 ? ' <span class="kit-seq">' + l.seq + '/' + l.total + '</span>' : '';
      var faltaTxt = '';
      if (fs.length) {
        var cods = fs.map(function (f) {
          var q = fmtQtd(f.qtd);
          return esc(f.codigo) + (q ? ' (faltam ' + esc(q) + ')' : '');
        });
        faltaTxt = ' <span class="kit-falta-tag">Falta: ' + cods.join(', ') + '</span>';
      }
      var dir = (l.estado === 'liberado' && pode)
        ? '<button type="button" class="btn primary kit-sep-btn" data-kit-sep="' + l.linha + '">Separar</button>'
        : '<span class="badge kit-badge ' + l.estado + '">' + labelEstado(l.estado) + '</span>';
      /* kit aguardando ainda não pode ser aberto */
      var dataKit = l.estado === 'aguardando' ? '' : ' data-kit="' + l.linha + '"';
      return '<div class="li kit-li ' + l.estado + '"' + dataKit + '>' +
        '<div class="li-main">' +
          '<div class="li-nome">' + htmlNomeMaquina(l.produto || '(sem produto)') + seq + '</div>' +
          '<div class="li-sub">Linha ' + l.linha + faltaTxt + '</div>' +
        '</div>' +
        dir +
      '</div>';
    }

    function renderLista() {
      var el = $(id + 'Lista');
      if (!el) return;
      renderControles();

      if (!temAcesso()) { el.innerHTML = vazio('Sem acesso ao módulo Kits.'); return; }
      if (estado.carregando && !estado.linhas) { el.innerHTML = vazio('Carregando kits...'); return; }
      if (!estado.linhas) {
        el.innerHTML = vazio(estado.erro || 'Toque em Atualizar para ler a planilha.');
        return;
      }
      if (!estado.linhas.length) { el.innerHTML = vazio('Esta aba não tem linhas de kit.'); return; }

      var itens = filtrar(estado.linhas, { estado: estado.filtro, busca: estado.busca });
      if (!itens.length) { el.innerHTML = vazio('Nenhum kit com esse filtro.'); return; }

      var pode = podeEditar();
      el.innerHTML = agruparPorCarga(itens, estado.linhas).map(function (g) {
        return '<div class="section-title kit-grupo">' +
            '<span>' + esc(g.carga) + '</span>' +
            '<span class="kit-grupo-cont">' + g.separados + '/' + g.total + ' separados</span>' +
          '</div>' +
          '<div class="list">' + g.itens.map(function (l) { return htmlLinha(l, pode); }).join('') + '</div>';
      }).join('');
    }

    /* =========================================================
       RENDER - histórico
       ========================================================= */
    function renderHistorico() {
      var el = $(id + 'HistLista');
      if (!el) return;
      if (!temAcesso()) { el.innerHTML = vazio('Sem acesso ao módulo Kits.'); return; }
      if (estado.histCarregando && !estado.hist) { el.innerHTML = vazio('Carregando histórico...'); return; }
      if (!estado.hist) { el.innerHTML = vazio(estado.histErro || 'Toque em Atualizar para ler o histórico.'); return; }

      var q = norm(estado.histBusca);
      var lista = estado.hist.filter(function (h) {
        if (!q) return true;
        return norm([h.carga, h.produto, h.usuario, h.aba].join(' ')).indexOf(q) !== -1;
      });
      if (!lista.length) {
        el.innerHTML = vazio(estado.hist.length ? 'Nada encontrado na busca.' : 'Nenhum kit separado ainda.');
        return;
      }
      var aviso = estado.histErro
        ? '<div class="muted small kits-status-erro">' + esc(estado.histErro) + ' (mostrando a última leitura)</div>' : '';
      el.innerHTML = aviso + lista.map(function (h) {
        var acao = h.acao === 'separar' ? 'Separado' : esc(h.acao || '');
        return '<div class="li kit-li separado" data-hist="' + esc(h.id) + '">' +
          '<div class="li-main">' +
            '<div class="li-code">' + esc(h.carga || 'Sem carga') + '</div>' +
            '<div class="li-nome">' + htmlNomeMaquina(h.produto) + '</div>' +
            '<div class="li-sub li-sup-ok">' + acao + (h.usuario ? ' por ' + esc(h.usuario) : '') +
              ' em ' + esc(P.fmtDataHora(h.criado_em)) + '</div>' +
            '<div class="li-sub">' + esc(h.aba) + ' - linha ' + esc(h.linha) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    /* =========================================================
       DETALHE DO KIT + FALTA
       ========================================================= */
    function pintarDetalhe() {
      var l = estado.alvo;
      if (!l) return;
      var pode = podeEditar();
      $(id + 'DetTitulo').textContent = l.produto || '(sem produto)';

      var fs = faltasDe(l);
      var fh = fs.length ? fs.map(function (f) {
        var q = fmtQtd(f.qtd);
        return '<div class="kit-falta-item"><b>' + esc(f.codigo) + '</b>' +
          (q ? '<span class="kit-falta-qtd">faltam ' + esc(q) + '</span>' : '') +
          '<span class="muted small">' + (f.criado_por ? esc(f.criado_por) + ' - ' : '') +
          esc(f.criado_em ? P.fmtDataHora(f.criado_em) : 'agora') + '</span></div>';
      }).join('') : '<div class="muted small">Nenhuma falta registrada para este kit.</div>';

      $(id + 'DetCorpo').innerHTML =
        '<div class="kv"><span>Carga</span><b>' + esc(l.carga || '-') + '</b></div>' +
        '<div class="kv"><span>Aba / linha</span><b>' + esc(estado.aba) + ' / ' + l.linha + '</b></div>' +
        (l.total > 1 ? '<div class="kv"><span>Repetido</span><b>' + l.seq + ' de ' + l.total + '</b></div>' : '') +
        '<div class="kv"><span>Situação</span><span class="badge kit-badge ' + l.estado + '">' + labelEstado(l.estado) + '</span></div>' +
        '<div class="lbl">Faltas vinculadas</div>' + fh;

      var ac = '';
      if (pode && l.estado === 'liberado') {
        ac += '<button id="' + id + 'DetSeparar" class="btn primary block" type="button">Separar este kit</button>';
      }
      if (pode && l.estado === 'separado') {
        /* kit já separado: não aceita mais falta */
        ac += '<p class="muted small">Kit já separado.</p>';
      } else if (pode) {
        ac += '<button id="' + id + 'DetFalta" class="btn ghost block" type="button">Registrar falta de componente</button>';
      } else {
        ac += '<p class="muted small">Seu usuário só pode consultar os kits.</p>';
      }
      ac += '<button id="' + id + 'DetFechar" class="btn ghost block" type="button">Fechar</button>';
      $(id + 'DetAcoes').innerHTML = ac;
    }

    function abrirDetalhe(linha) {
      var l = buscarLinha(linha);
      if (!l || l.estado === 'aguardando') return;
      estado.alvo = l;
      fecharFormFalta();
      pintarDetalhe();
      $(id + 'SheetKit').classList.add('open');
    }

    /* detalhe (só leitura) de um kit do histórico */
    function abrirDetalheHist(hid) {
      var h = null;
      (estado.hist || []).forEach(function (x) { if (String(x.id) === String(hid)) h = x; });
      if (!h) return;
      estado.alvo = null;
      fecharFormFalta();
      var c = cacheAba[h.aba];
      var fs = ((c && c.faltas) || []).filter(function (f) {
        return Number(f.linha) === Number(h.linha) && norm(f.produto) === norm(h.produto) && !f.suprida_em;
      });
      var fh = fs.length ? fs.map(function (f) {
        var q = fmtQtd(f.qtd);
        return '<div class="kit-falta-item"><b>' + esc(f.codigo) + '</b>' +
          (q ? '<span class="kit-falta-qtd">faltam ' + esc(q) + '</span>' : '') + '</div>';
      }).join('') : '<div class="muted small">Nenhuma falta em aberto para este kit.</div>';
      $(id + 'DetTitulo').textContent = h.produto || '(sem produto)';
      $(id + 'DetCorpo').innerHTML =
        '<div class="kv"><span>Carga</span><b>' + esc(h.carga || '-') + '</b></div>' +
        '<div class="kv"><span>Aba / linha</span><b>' + esc(h.aba) + ' / ' + esc(h.linha) + '</b></div>' +
        '<div class="kv"><span>Separado por</span><b>' + esc(h.usuario || '-') + '</b></div>' +
        '<div class="kv"><span>Quando</span><b>' + esc(P.fmtDataHora(h.criado_em)) + '</b></div>' +
        '<div class="lbl">Faltas vinculadas</div>' + fh;
      $(id + 'DetAcoes').innerHTML =
        '<button id="' + id + 'DetFechar" class="btn ghost block" type="button">Fechar</button>';
      $(id + 'SheetKit').classList.add('open');
    }

    function abrirFormFalta() {
      if (!estado.alvo || !podeEditar() || estado.alvo.estado === 'separado') return;
      $(id + 'FCodigo').value = '';
      $(id + 'FNome').value = '';
      $(id + 'FQtd').value = '1';
      $(id + 'FDica').textContent = '';
      $(id + 'FLista').innerHTML = '';
      estado.nomeAuto = false;
      definirAlmFalta('frente');
      $(id + 'FaltaKit').textContent = (estado.alvo.carga ? estado.alvo.carga + ' - ' : '') +
        (estado.alvo.produto || '');
      $(id + 'SheetFalta').classList.add('open');
      /* acorda a base de componentes do módulo Faltas */
      if (window.ModuloFaltas) window.ModuloFaltas.garantirPronto()['catch'](function () {});
      setTimeout(function () { var c = $(id + 'FCodigo'); if (c) c.focus(); }, 120);
    }

    function definirAlmFalta(cod) {
      estado.almFalta = cod === 'fundo' ? 'fundo' : 'frente';
      qsa('#' + id + 'FAlm button').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-alm') === estado.almFalta);
      });
    }

    function aoDigitarCodigo() {
      clearTimeout(tDigita);
      tDigita = setTimeout(function () {
        var F = window.ModuloFaltas;
        var campo = $(id + 'FCodigo');
        if (!campo) return;
        var txt = campo.value.trim();
        var dica = $(id + 'FDica'), nome = $(id + 'FNome');
        if (!F || !txt) {
          $(id + 'FLista').innerHTML = '';
          dica.textContent = '';
          return;
        }
        F.sugerirComponentes(txt, 8).then(function (lista) {
          $(id + 'FLista').innerHTML = (lista || []).map(function (c) {
            return '<option value="' + esc(c.codigo) + '">' + esc(c.nome) + '</option>';
          }).join('');
        })['catch'](function () {});
        F.buscarComponente(txt).then(function (c) {
          if (campo.value.trim() !== txt) return;
          if (c) {
            nome.value = c.nome;
            estado.nomeAuto = true;
            dica.textContent = 'Componente da base de faltas.';
          } else {
            if (estado.nomeAuto) nome.value = '';
            estado.nomeAuto = false;
            dica.textContent = 'Código fora da base: digite o nome do componente.';
          }
        })['catch'](function () {});
      }, 250);
    }

    function salvarFalta() {
      if (estado.ocupado) return;
      var l = estado.alvo;
      var F = window.ModuloFaltas;
      if (!l) return;
      if (l.estado === 'separado') { toast('Kit já separado: não aceita falta', 'err'); return; }
      if (!F) { toast('Módulo de faltas indisponível', 'err'); return; }

      var codigo = $(id + 'FCodigo').value.trim();
      var nome = $(id + 'FNome').value.trim();
      var qtd = Number(String($(id + 'FQtd').value).replace(',', '.'));
      if (!codigo) { toast('Digite o código do componente', 'err'); return; }
      if (!(qtd >= 1)) { toast('Quantidade deve ser 1 ou mais', 'err'); return; }

      var btn = $(id + 'FSalvar');
      estado.ocupado = true;
      btn.disabled = true;
      btn.textContent = 'Registrando...';
      var aba = estado.aba;

      F.registrarExterno({
        codigo: codigo, nome: nome, qtd: qtd, almox: estado.almFalta, origem: 'kits'
      }).then(function (r) {
        var fid = String(r.id);
        var ja = faltasDe(l).some(function (f) { return String(f.falta_id) === fid; });
        if (ja) return { r: r, vinculo: 'ja' };
        return Promise.resolve().then(function () {
          return nv().kitsFaltaVincular({
            aba: aba, linha: l.linha, carga: l.carga, produto: l.produto,
            falta_id: fid, codigo: r.codigo, criado_por: operador()
          });
        }).then(function () {
          adicionarFaltaLocal(aba, l, fid, r.codigo, (r.qtd != null ? r.qtd : qtd));
          return { r: r, vinculo: 'ok' };
        }, function (e) {
          return { r: r, vinculo: 'erro', erro: msgErro(e) };
        });
      }).then(function (res) {
        if (res.vinculo === 'erro') {
          toast('Falta registrada, mas sem vínculo com o kit: ' + res.erro, 'err');
        } else {
          toast(res.vinculo === 'ja' ? 'Falta já estava vinculada a este kit' : 'Falta registrada e vinculada ao kit', 'ok');
        }
        fecharFormFalta();
        pintarDetalhe();
        renderLista();
      })['catch'](function (e) {
        toast((e && e.message) || 'Falha ao registrar a falta', 'err');
      }).then(function () {
        estado.ocupado = false;
        btn.disabled = false;
        btn.textContent = 'Registrar falta';
      });
    }

    function adicionarFaltaLocal(aba, l, fid, codigo, qtd) {
      var obj = {
        aba: aba, linha: l.linha, carga: l.carga, produto: l.produto,
        falta_id: fid, codigo: codigo, qtd: qtd, suprida_em: null,
        criado_por: operador(), criado_em: null
      };
      var c = cacheAba[aba];
      if (c) {
        c.faltas = (c.faltas || []).concat([obj]);
        estado.faltas = agruparFaltas(c.faltas, c.linhas);
      } else {
        if (!estado.faltas[l.linha]) estado.faltas[l.linha] = [];
        estado.faltas[l.linha].push(obj);
      }
    }

    /* =========================================================
       SEPARAR
       ========================================================= */
    function abrirSeparar(linha) {
      var l = buscarLinha(linha);
      if (!l || !podeEditar()) return;
      if (l.estado !== 'liberado') { toast('Este kit não está liberado para separar', 'err'); return; }
      estado.alvo = l;
      $(id + 'SepTxt').textContent = (l.carga ? l.carga + ' - ' : '') + l.produto +
        (l.total > 1 ? ' (' + l.seq + ' de ' + l.total + ')' : '');
      $(id + 'SheetKit').classList.remove('open');
      $(id + 'SheetSep').classList.add('open');
    }

    function confirmarSeparar() {
      if (estado.ocupado) return;
      var l = estado.alvo;
      if (!l) return;
      var aba = estado.aba;
      var btn = $(id + 'SepOk');
      estado.ocupado = true;
      btn.disabled = true;
      btn.textContent = 'Separando...';

      Promise.resolve().then(function () {
        return nv().kitsSeparar({
          aba: aba, linha: l.linha, produto: l.produto, carga: l.carga, usuario: operador()
        });
      }).then(function (res) {
        l.almoxFrente = true;
        l.estado = 'separado';
        $(id + 'SheetSep').classList.remove('open');
        toast(res && res.jaEstava ? 'Este kit já estava separado' : 'Kit separado', 'ok');
        if (!(res && res.jaEstava)) { try { P.vibrar(40); } catch (e) {} }
        /* o histórico guardado no servidor mudou */
        estado.histT = 0;
        renderLista();
      })['catch'](function (e) {
        toast(msgErro(e), 'err');
        if (e && e.status === 409) {
          /* a planilha mudou: fecha e relê, ignorando o cache */
          $(id + 'SheetSep').classList.remove('open');
          carregar(true);
        }
      }).then(function () {
        estado.ocupado = false;
        btn.disabled = false;
        btn.textContent = 'Separar';
      });
    }

    /* =========================================================
       EVENTOS
       ========================================================= */
    function ligarEventos() {
      /* abas próprias: o ligarEventos() do app.js já rodou antes destas existirem */
      qsa('#tabbar-' + id + ' .tab').forEach(function (t) {
        t.addEventListener('click', function () { P.mostrarView(t.dataset.view); });
      });

      $(id + 'Atualizar').addEventListener('click', function () { carregar(true); });

      $(id + 'Aba').addEventListener('change', function (ev) {
        estado.aba = ev.target.value;
        estado.linhas = null;
        estado.faltas = {};
        carregar(false);
      });

      $(id + 'Busca').addEventListener('input', function (ev) {
        var v = ev.target.value;
        clearTimeout(tBusca);
        tBusca = setTimeout(function () { estado.busca = v; renderLista(); }, 150);
      });
      $(id + 'LimpaBusca').addEventListener('click', function () {
        $(id + 'Busca').value = '';
        estado.busca = '';
        renderLista();
      });

      $(id + 'Filtros').addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-filtro]');
        if (!b) return;
        estado.filtro = b.getAttribute('data-filtro');
        renderLista();
      });

      $(id + 'Lista').addEventListener('click', function (ev) {
        var s = ev.target.closest('[data-kit-sep]');
        if (s) { abrirSeparar(Number(s.getAttribute('data-kit-sep'))); return; }
        var r = ev.target.closest('[data-kit]');
        if (r) abrirDetalhe(Number(r.getAttribute('data-kit')));
      });

      $(id + 'HistLista').addEventListener('click', function (ev) {
        var r = ev.target.closest('[data-hist]');
        if (r) abrirDetalheHist(r.getAttribute('data-hist'));
      });
      $(id + 'HistAtualizar').addEventListener('click', function () { carregarHistorico(true); });
      $(id + 'HistBusca').addEventListener('input', function (ev) {
        estado.histBusca = ev.target.value;
        renderHistorico();
      });

      /* sheet do detalhe */
      var sk = $(id + 'SheetKit');
      sk.addEventListener('click', function (ev) {
        if (ev.target === sk) { fecharSheets(); return; }
        if (ev.target.closest('.janela-x')) { fecharSheets(); return; }
        if (ev.target.closest('#' + id + 'DetFechar')) { fecharSheets(); return; }
        if (ev.target.closest('#' + id + 'DetFalta')) { abrirFormFalta(); return; }
        if (ev.target.closest('#' + id + 'DetSeparar')) {
          if (estado.alvo) abrirSeparar(estado.alvo.linha);
        }
      });
      $(id + 'FCodigo').addEventListener('input', aoDigitarCodigo);
      $(id + 'FNome').addEventListener('input', function () { estado.nomeAuto = false; });
      $(id + 'FAlm').addEventListener('click', function (ev) {
        var b = ev.target.closest('button[data-alm]');
        if (b) definirAlmFalta(b.getAttribute('data-alm'));
      });
      $(id + 'FSalvar').addEventListener('click', salvarFalta);

      /* janela de registrar falta: fecha só ela, o detalhe do kit continua atrás */
      var sf = $(id + 'SheetFalta');
      sf.addEventListener('click', function (ev) {
        if (ev.target === sf || ev.target.closest('.janela-x')) fecharFormFalta();
      });
      $(id + 'FCancela').addEventListener('click', fecharFormFalta);
      $(id + 'FQtd').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); salvarFalta(); }
      });

      /* sheet de confirmação */
      var ss = $(id + 'SheetSep');
      ss.addEventListener('click', function (ev) {
        if (ev.target === ss || ev.target.closest('.janela-x')) ss.classList.remove('open');
      });
      $(id + 'SepCancela').addEventListener('click', function () { ss.classList.remove('open'); });
      $(id + 'SepOk').addEventListener('click', confirmarSeparar);

      /* Esc fecha a janela que estiver por cima (PC) */
      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') return;
        if (sf.classList.contains('open')) { fecharFormFalta(); return; }
        if (ss.classList.contains('open')) { ss.classList.remove('open'); return; }
        if (sk.classList.contains('open')) fecharSheets();
      });
    }

    /* ---------- API da instância ---------- */
    var promessa = null;
    return {
      cfg: cfg,
      /* só monta a tela (o módulo Banco também chama isto para todos os
         motores): nenhuma leitura de planilha acontece aqui */
      preparar: function () {
        if (!promessa) {
          promessa = Promise.resolve().then(function () { montarUI(); });
        }
        return promessa;
      },
      aoMostrarView: function (nome) {
        if (!montado) return;
        if (nome === id + '-lista') { renderLista(); carregar(false); }
        else if (nome === id + '-historico') { renderHistorico(); carregarHistorico(false); }
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
    },
    fecharSheets: function () {
      Object.keys(instancias).forEach(function (k) { instancias[k].fecharSheets(); });
    },

    /* lógica pura, para teste em node (ver teste de fumaça no relatório) */
    _testes: {
      semAcento: semAcento,
      derivarEstado: derivarEstado,
      parseAba: parseAba,
      ordenarAbas: ordenarAbas,
      abaPadrao: abaPadrao,
      decorar: decorar,
      contar: contar,
      filtrar: filtrar,
      agruparPorCarga: agruparPorCarga,
      agruparFaltas: agruparFaltas,
      cacheValido: cacheValido,
      msgErro: msgErro
    }
  };
})();
