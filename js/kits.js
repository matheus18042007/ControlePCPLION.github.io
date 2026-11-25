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
   A leitura de cada aba fica em cache por 20 s. Com a lista de kits
   na tela, o app relê o espelho sozinho a cada AUTO_MS (só o
   Supabase, não a planilha, então não gasta cota do Google).
   ========================================================= */
window.ModuloKits = (function () {
  'use strict';

  var CACHE_MS = 20000;          /* leitura de uma aba */
  var CACHE_ABAS_MS = 300000;    /* lista de abas (muda raramente) */
  var AUTO_MS = 30000;           /* releitura automática com a lista na tela */
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

  /* f.estado ('' = todos) e f.busca (carga ou produto, sem acento);
     f.extra(l) opcional: texto a mais pesquisavel (ex.: codigo do kit) */
  function filtrar(linhas, f) {
    var o = f || {};
    var est = o.estado || '';
    var q = norm(o.busca || '');
    return (linhas || []).filter(function (l) {
      if (est && (l.estado || derivarEstado(l)) !== est) return false;
      var extra = o.extra ? ' ' + o.extra(l) : '';
      if (q && norm(l.carga + ' ' + l.produto + extra).indexOf(q) === -1) return false;
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
      alvo: null, ocupado: false, almFalta: 'frente', nomeAuto: false, editando: null,
      hist: null, histT: 0, histBusca: '', histCarregando: false, histErro: '',
      /* sobras: catalogo (kit -> produto/quadro/anilheiro) e saldo por kit */
      catalogo: null, catT: 0, sobras: null, sobT: 0, sobBusca: '',
      sobCarregando: false, sobErro: '', sobOcupado: false, sobAlvo: '',
      /* cargas que ainda podem receber o kit aberto na janela da sobra */
      sobDest: null
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
      try { garantirCatalogo(); } catch (e0) {}
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

    /* releitura silenciosa: sem "carregando", sem piscar; só redesenha se
       algo mudou. Não roda com janela aberta (detalhe/falta/separar). */
    function algoAberto() {
      return ['SheetKit', 'SheetFalta', 'SheetSep', 'SheetSobra', 'SheetSobNova'].some(function (s) {
        var el = $(id + s);
        return el && el.classList.contains('open');
      });
    }

    function assinatura() {
      return String(estado.sync) + JSON.stringify(estado.linhas) + JSON.stringify(estado.faltas);
    }

    function autoAtualizar() {
      var v = $('view-' + id + '-lista');
      if (!montado || document.hidden || estado.carregando || estado.ocupado || !estado.aba ||
          !temAcesso() || !v || !v.classList.contains('active') || algoAberto()) return;
      var aba = estado.aba;
      var antes = assinatura();
      lerAba(aba, true).then(function () {
        if (estado.aba !== aba) {
          /* trocou de aba durante a leitura: devolve os dados da aba atual */
          var c = cacheAba[estado.aba];
          if (c) aplicarCache(c); else { estado.linhas = null; estado.faltas = {}; }
          return;
        }
        if (assinatura() !== antes && !algoAberto()) {
          renderLista();
          try { P.atualizarStatusNuvem(); } catch (e) {}
        }
      }, function () { /* falha de rede em segundo plano: tenta de novo no próximo ciclo */ });
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
        '    <input id="' + id + 'Busca" type="search" inputmode="search" placeholder="Buscar carga, produto ou kit..." autocomplete="off">',
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
        '</section>',

        /* ---------- ABA 3: SOBRAS ---------- */
        '<section id="view-' + id + '-sobras" class="view" data-modulo="' + id + '">',
        '  <div class="kits-topo">',
        '    <span class="muted small kits-status">Kits que sobraram, por código do kit</span>',
        '    <button id="' + id + 'SobAtualizar" class="pill" type="button">&#8635; Atualizar</button>',
        '  </div>',
        '  <button id="' + id + 'SobAbrir" class="btn primary block" type="button">Registrar sobra</button>',
        '  <div class="searchbar">',
        '    <input id="' + id + 'SobBusca" type="search" inputmode="search" placeholder="Buscar kit, código ou produto..." autocomplete="off">',
        '  </div>',
        '  <div id="' + id + 'SobStatus" class="muted small kits-status"></div>',
        '  <div id="' + id + 'SobItens" class="list"></div>',
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
        '<button class="tab" data-view="' + id + '-historico" type="button"><span>&#8634;</span>Histórico</button>',
        '<button class="tab" data-view="' + id + '-sobras" type="button"><span>&#8853;</span>Sobras</button>'
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
        '    <h3 id="' + id + 'FTitulo">Registrar falta de componente</h3>',
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
        '      <button id="' + id + 'FExcluir" class="btn ghost block kit-falta-excluir" type="button" hidden>Excluir esta falta</button>',
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
        '</div>',

        '<div id="' + id + 'SheetSobNova" class="sheet-wrap janela-pc" data-modulo="' + id + '">',
        '  <div class="sheet">',
        '    <div class="sheet-handle"></div>',
        '    <button class="janela-x" type="button" aria-label="Fechar">&times;</button>',
        '    <h3>Registrar sobra</h3>',
        '    <label class="lbl">Código do kit</label>',
        '    <input id="' + id + 'SobKit" type="text" inputmode="numeric" autocomplete="off" list="' + id + 'SobLista" placeholder="Digite o código do kit">',
        '    <datalist id="' + id + 'SobLista"></datalist>',
        '    <p id="' + id + 'SobInfo" class="muted small"></p>',
        '    <label class="lbl">Quantidade que sobrou</label>',
        '    <input id="' + id + 'SobQtd" type="number" inputmode="numeric" min="1" step="1" value="1">',
        '    <div class="sheet-actions">',
        '      <button id="' + id + 'SobCancelar" class="btn ghost" type="button">Cancelar</button>',
        '      <button id="' + id + 'SobRegistrar" class="btn primary" type="button">Registrar sobra</button>',
        '    </div>',
        '  </div>',
        '</div>',

        '<div id="' + id + 'SheetSobra" class="sheet-wrap janela-pc" data-modulo="' + id + '">',
        '  <div class="sheet">',
        '    <div class="sheet-handle"></div>',
        '    <button class="janela-x" type="button" aria-label="Fechar">&times;</button>',
        '    <h3 id="' + id + 'SobTitulo">Kit</h3>',
        '    <div id="' + id + 'SobCorpo"></div>',
        '    <div class="section-title">Remanejar para uma carga</div>',
        '    <div id="' + id + 'SobDest" class="muted small"></div>',
        '    <label class="lbl">Quantidade</label>',
        '    <input id="' + id + 'SobMQtd" type="number" inputmode="numeric" min="0" step="1" value="1">',
        '    <label class="lbl">Observação (opcional)</label>',
        '    <input id="' + id + 'SobMObs" type="text" autocomplete="off" maxlength="200">',
        '    <div class="sheet-actions">',
        '      <button id="' + id + 'SobSomar" class="btn ghost" type="button">Somar</button>',
        '      <button id="' + id + 'SobBaixa" class="btn ghost" type="button">Dar baixa</button>',
        '      <button id="' + id + 'SobDefinir" class="btn primary" type="button">Definir saldo</button>',
        '    </div>',
        '    <div class="section-title">Movimentações</div>',
        '    <div id="' + id + 'SobHist" class="muted small"></div>',
        '  </div>',
        '</div>'
      ].join('\n');
      while (sheets.firstChild) document.body.appendChild(sheets.firstChild);

      ligarEventos();
    }

    function fecharSheets() {
      var a = $(id + 'SheetKit'), b = $(id + 'SheetSep'), c = $(id + 'SheetSobra'), n = $(id + 'SheetSobNova');
      if (a) a.classList.remove('open');
      if (b) b.classList.remove('open');
      if (c) c.classList.remove('open');
      if (n) n.classList.remove('open');
      fecharFormFalta();
    }

    function fecharFormFalta() {
      var f = $(id + 'SheetFalta');
      if (f) f.classList.remove('open');
      estado.editando = null;
    }

    /* o mesmo formulário serve para registrar (modo novo) e corrigir (modo edição) */
    function modoFormFalta(editando) {
      $(id + 'FTitulo').textContent = editando ? 'Editar falta' : 'Registrar falta de componente';
      $(id + 'FSalvar').textContent = editando ? 'Salvar alterações' : 'Registrar falta';
      $(id + 'FExcluir').hidden = !editando;
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
          '<div class="li-sub">Linha ' + l.linha + kitsTxt(l) + faltaTxt + '</div>' +
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

      var itens = filtrar(estado.linhas, {
        estado: estado.filtro, busca: estado.busca,
        extra: function (l) { return kitsDaLinha(l).map(function (k) { return 'kit ' + k; }).join(' '); }
      });
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
        var acao = h.acao === 'separar' ? 'Separado'
                 : h.acao === 'remanejar' ? 'Kit liberado (sobra)'
                 : esc(h.acao || '');
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
       SOBRAS - kits que sobraram, por código do kit
       ========================================================= */
    var catMapa = {};   /* kit_cod -> { cod, nome, produtos[], quadros[], anilheiros[] } */
    var sobRepetir = false, tBuscaSob = null, promessaSob = null;

    function limpaNome(s) { return String(s == null ? '' : s).replace(/^\s*-\s*/, '').trim(); }
    function juntar(arr, v) { v = limpaNome(v); if (v && arr.indexOf(v) === -1) arr.push(v); }

    /* produto_cod sem zeros a esquerda -> [kit_cod]; a planilha traz "08327",
       o catalogo "8327" */
    var kitsPorProduto = {};
    function codSemZero(c) { return String(c == null ? '' : c).trim().replace(/^0+(?=\d)/, ''); }

    function kitsDaLinha(l) {
      var m = /(\d+)\s*-\s*\S/.exec(String((l && l.produto) || ''));
      return (m && kitsPorProduto[codSemZero(m[1])]) || [];
    }

    function kitsTxt(l) {
      var ks = kitsDaLinha(l);
      return ks.length ? ' <span class="kit-cod-tag">Kit ' + esc(ks.join(', ')) + '</span>' : '';
    }

    /* o card da lista mostra o kit: carrega o catalogo em segundo plano */
    function garantirCatalogo() {
      if (estado.catalogo && cacheValido(estado.catT, Date.now(), CACHE_ABAS_MS)) return;
      if (garantirCatalogo.p) return;
      garantirCatalogo.p = Promise.resolve().then(function () { return nv().kitsCatalogo(); })
        .then(function (r) {
          if (r) { estado.catalogo = r; estado.catT = Date.now(); montarCatMapa(); renderLista(); }
        }, function () { /* sem catalogo: card fica sem o codigo do kit */ })
        .then(function () { garantirCatalogo.p = null; });
    }

    function montarCatMapa() {
      catMapa = {};
      kitsPorProduto = {};
      (estado.catalogo || []).forEach(function (r) {
        var k = String(r.kit_cod);
        var pc = codSemZero(r.produto_cod);
        if (pc) {
          var lk = kitsPorProduto[pc] || (kitsPorProduto[pc] = []);
          if (lk.indexOf(k) === -1) lk.push(k);
        }
        var o = catMapa[k] || (catMapa[k] = { cod: k, nome: limpaNome(r.kit_nome), produtos: [], quadros: [], anilheiros: [] });
        juntar(o.produtos, r.produto_nome || r.produto_cod);
        juntar(o.quadros, r.quadro_pint_nome || r.quadro_nome);
        juntar(o.anilheiros, r.anilheiro_nome);
      });
    }

    function descricaoKit(o) {
      var h = '<b>' + esc(o.nome || ('Kit ' + o.cod)) + '</b>';
      if (o.produtos.length) h += '<br>Produto: ' + esc(o.produtos.join(', '));
      if (o.quadros.length) h += '<br>Quadro: ' + esc(o.quadros.join(', '));
      if (o.anilheiros.length) h += '<br>Anilheiro: ' + esc(o.anilheiros.join(', '));
      return h;
    }

    function saldoSobra(cod) {
      var ls = estado.sobras || [];
      for (var i = 0; i < ls.length; i++) if (String(ls[i].kit_cod) === String(cod)) return Number(ls[i].qtd) || 0;
      return 0;
    }

    function preencherListaCodigos() {
      var dl = $(id + 'SobLista');
      if (!dl || !estado.catalogo || dl.getAttribute('data-t') === String(estado.catT)) return;
      dl.setAttribute('data-t', String(estado.catT));
      dl.innerHTML = Object.keys(catMapa).sort(function (a, b) { return Number(a) - Number(b); }).map(function (k) {
        return '<option value="' + esc(k) + '">' + esc(catMapa[k].nome) + '</option>';
      }).join('');
    }

    function atualizarInfoSobra() {
      var info = $(id + 'SobInfo');
      if (!info) return;
      var cod = ($(id + 'SobKit').value || '').trim();
      if (!cod) info.textContent = '';
      else if (!estado.catalogo) info.textContent = 'Carregando catálogo de kits...';
      else if (catMapa[cod]) info.innerHTML = descricaoKit(catMapa[cod]);
      else info.textContent = 'Código de kit não encontrado no catálogo.';
    }

    function carregarSobras(forcar, recatalogar) {
      if (!temAcesso()) { renderSobras(); return Promise.resolve(); }
      if (estado.sobCarregando) {
        /* leitura forçada durante outra em andamento (ex.: logo após gravar):
           a em andamento pode ter lido o saldo antigo, então repete ao final */
        if (forcar) sobRepetir = true;
        /* quem chamou espera a leitura em andamento (e a repetição, se houver) */
        return promessaSob || Promise.resolve();
      }
      if (!forcar && estado.sobras && cacheValido(estado.sobT, Date.now(), CACHE_MS)) {
        renderSobras();
        return Promise.resolve();
      }
      estado.sobCarregando = true;
      estado.sobErro = '';
      renderSobras();
      var precisaCat = !!recatalogar || !estado.catalogo || !cacheValido(estado.catT, Date.now(), CACHE_ABAS_MS);
      promessaSob = Promise.resolve().then(function () {
        return Promise.all([precisaCat ? nv().kitsCatalogo() : null, nv().kitsSobras()]);
      }).then(function (r) {
        if (r[0]) { estado.catalogo = r[0]; estado.catT = Date.now(); montarCatMapa(); }
        estado.sobras = r[1] || [];
        estado.sobT = Date.now();
      })['catch'](function (e) {
        estado.sobErro = msgErro(e);
      }).then(function () {
        estado.sobCarregando = false;
        renderSobras();
        atualizarInfoSobra();
        if (sobRepetir) { sobRepetir = false; return carregarSobras(true, false); }
      });
      return promessaSob;
    }

    function renderSobras() {
      var el = $(id + 'SobItens');
      if (!el) return;
      var st = $(id + 'SobStatus');
      preencherListaCodigos();
      if (!temAcesso()) { el.innerHTML = vazio('Sem acesso ao módulo Kits.'); if (st) st.textContent = ''; return; }
      if (estado.sobCarregando && !estado.sobras) { el.innerHTML = vazio('Carregando sobras...'); return; }
      if (!estado.sobras) { el.innerHTML = vazio(estado.sobErro || 'Toque em Atualizar para ler as sobras.'); return; }

      var q = norm(estado.sobBusca);
      var todos = estado.sobras.filter(function (s) { return Number(s.qtd) > 0; });
      var lista = todos.filter(function (s) {
        if (!q) return true;
        var o = catMapa[String(s.kit_cod)];
        return norm([s.kit_cod, s.kit_nome, o ? o.produtos.join(' ') : ''].join(' ')).indexOf(q) !== -1;
      });
      var total = todos.reduce(function (n, s) { return n + (Number(s.qtd) || 0); }, 0);
      if (st) {
        st.textContent = todos.length + ' kit(s) com sobra, ' + total + ' unidade(s) no total' +
          (estado.sobErro ? ' - ' + estado.sobErro + ' (última leitura)' : '');
      }
      if (!lista.length) {
        el.innerHTML = vazio(todos.length ? 'Nada encontrado na busca.' : 'Nenhuma sobra registrada.');
        return;
      }
      el.innerHTML = lista.map(function (s) {
        var o = catMapa[String(s.kit_cod)];
        return '<div class="li kit-li" data-sobra="' + esc(s.kit_cod) + '">' +
          '<div class="li-main">' +
            '<div class="li-code">Kit ' + esc(s.kit_cod) + ' <span class="badge">' + esc(s.qtd) + ' un</span></div>' +
            '<div class="li-nome">' + esc(limpaNome(s.kit_nome) || (o && o.nome) || '') + '</div>' +
            (o && o.produtos.length ? '<div class="li-sub">' + esc(o.produtos.join(', ')) + '</div>' : '') +
            '<div class="li-sub">Atualizado em ' + esc(P.fmtDataHora(s.atualizado_em)) +
              (s.atualizado_por ? ' por ' + esc(s.atualizado_por) : '') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function setBotoesSobra(ocupado) {
      ['SobRegistrar', 'SobSomar', 'SobBaixa', 'SobDefinir'].forEach(function (b) {
        var el = $(id + b);
        if (el) el.disabled = !!ocupado;
      });
      var dst = $(id + 'SobDest');
      if (dst) {
        Array.prototype.forEach.call(dst.querySelectorAll('button[data-rem]'), function (b) {
          b.disabled = !!ocupado;
        });
      }
    }

    /* uma única porta de escrita: entrada (soma), baixa (subtrai), ajuste (define) */
    function executarSobra(cod, acao, qtd, obs) {
      if (!podeEditar()) { toast('Seu usuário não pode editar este módulo', 'err'); return Promise.resolve(false); }
      if (estado.sobOcupado) return Promise.resolve(false);
      estado.sobOcupado = true;
      setBotoesSobra(true);
      return Promise.resolve().then(function () {
        return nv().kitsSobraMover({ kit: cod, acao: acao, qtd: qtd, usuario: operador(), obs: obs });
      }).then(function (r) {
        var rot = acao === 'entrada' ? 'Sobra registrada' : acao === 'baixa' ? 'Baixa registrada' : 'Saldo definido';
        toast(rot + '. Saldo do kit ' + cod + ': ' + (r && r.qtd != null ? r.qtd : '?'), 'ok');
        return true;
      })['catch'](function (e) {
        toast(msgErro(e), 'err');
        return false;
      }).then(function (ok) {
        estado.sobOcupado = false;
        setBotoesSobra(false);
        if (!ok) return false;
        return carregarSobras(true, false).then(function () { return true; });
      });
    }

    function registrarSobra() {
      var cod = ($(id + 'SobKit').value || '').trim();
      var qtd = Number($(id + 'SobQtd').value);
      if (!cod) { toast('Digite o código do kit', 'err'); return; }
      if (!estado.catalogo) { toast('Catálogo ainda carregando, tente de novo', 'err'); return; }
      if (!catMapa[cod]) { toast('Código de kit não encontrado no catálogo', 'err'); return; }
      if (!isFinite(qtd) || qtd < 1 || Math.floor(qtd) !== qtd) { toast('A quantidade deve ser um número inteiro de 1 ou mais', 'err'); return; }
      executarSobra(cod, 'entrada', qtd, '').then(function (ok) {
        if (!ok) return;
        $(id + 'SobKit').value = '';
        $(id + 'SobQtd').value = '1';
        atualizarInfoSobra();
        $(id + 'SheetSobNova').classList.remove('open');
      });
    }

    function abrirNovaSobra() {
      $(id + 'SobKit').value = '';
      $(id + 'SobQtd').value = '1';
      atualizarInfoSobra();
      $(id + 'SheetSobNova').classList.add('open');
      setTimeout(function () { var k = $(id + 'SobKit'); if (k) k.focus(); }, 120);
    }

    function textoMov(h) {
      var n = Number(h.delta) || 0;
      var acao = h.acao === 'entrada' ? 'Entrada +' + n
               : h.acao === 'baixa' ? 'Baixa ' + n
               : 'Ajuste (' + (n >= 0 ? '+' : '') + n + ')';
      return '<div class="kit-falta-item">' + esc(acao) + ' = saldo ' + esc(h.qtd_apos) +
        (h.usuario ? ' - ' + esc(h.usuario) : '') + ' em ' + esc(P.fmtDataHora(h.criado_em)) +
        (h.obs ? '<br>' + esc(h.obs) : '') + '</div>';
    }

    function pintarSobra(cod) {
      var o = catMapa[cod];
      $(id + 'SobTitulo').textContent = 'Kit ' + cod;
      $(id + 'SobCorpo').innerHTML = (o ? '<p class="small">' + descricaoKit(o) + '</p>' : '') +
        '<p>Saldo atual: <b>' + esc(saldoSobra(cod)) + '</b> un</p>';
      var h = $(id + 'SobHist');
      h.textContent = 'Carregando...';
      Promise.resolve().then(function () {
        return nv().kitsSobrasHist({ kit: cod, limite: 30 });
      }).then(function (lista) {
        if (estado.sobAlvo !== cod) return;
        h.innerHTML = (lista && lista.length) ? lista.map(textoMov).join('') : 'Nenhuma movimentação.';
      })['catch'](function (e) {
        if (estado.sobAlvo === cod) h.textContent = msgErro(e);
      });
      pintarDestinos(cod);
    }

    /* semanas de hoje em diante primeiro (as mais urgentes); as já passadas
       ficam no fim. Dentro da semana, pela ordem da linha da planilha. */
    function ordenarDestinos(lista) {
      var abas = [];
      lista.forEach(function (d) { if (abas.indexOf(d.aba) === -1) abas.push(d.aba); });
      var cron = ordenarAbas(abas);
      var ini = cron.indexOf(abaPadrao(abas));
      var ordem = ini < 0 ? cron : cron.slice(ini).concat(cron.slice(0, ini));
      return lista.slice().sort(function (a, b) {
        var x = ordem.indexOf(a.aba) - ordem.indexOf(b.aba);
        return x !== 0 ? x : Number(a.linha) - Number(b.linha);
      });
    }

    /* cargas em que a coluna KIT ainda não está marcada e cujo produto usa este kit */
    function pintarDestinos(cod) {
      var el = $(id + 'SobDest');
      if (!el) return;
      estado.sobDest = null;
      if (saldoSobra(cod) < 1) { el.textContent = 'Sem saldo deste kit para remanejar.'; return; }
      el.textContent = 'Procurando cargas...';
      Promise.resolve().then(function () {
        return nv().kitsSobraDestinos(cod);
      }).then(function (lista) {
        if (estado.sobAlvo !== cod) return;
        estado.sobDest = ordenarDestinos(lista || []);
        renderDestinos();
      })['catch'](function (e) {
        if (estado.sobAlvo === cod) { estado.sobDest = null; el.textContent = msgErro(e); }
      });
    }

    function renderDestinos() {
      var el = $(id + 'SobDest');
      var l = estado.sobDest;
      if (!el || !l) return;
      if (!l.length) {
        el.textContent = 'Nenhuma carga precisa deste kit agora (todas já estão com a coluna KIT marcada).';
        return;
      }
      var pode = podeEditar();
      /* agrupa por semana (aba) e, dentro dela, por carga; o índice i continua
         sendo o da lista ordenada, que é o que o botão data-rem usa */
      var semanas = [], porSemana = {};
      l.forEach(function (d, i) {
        var s = porSemana[d.aba];
        if (!s) { s = porSemana[d.aba] = { aba: d.aba, cargas: [], mapa: {} }; semanas.push(s); }
        var ck = String(d.carga || '?');
        var c = s.mapa[ck];
        if (!c) { c = s.mapa[ck] = { carga: ck, itens: [] }; s.cargas.push(c); }
        c.itens.push({ d: d, i: i });
      });
      el.innerHTML = '<p class="muted small">' + l.length + ' linha(s) ainda sem o kit liberado</p>' +
        semanas.map(function (s) {
          return '<div class="section-title">Semana ' + esc(s.aba) + '</div>' +
            s.cargas.map(function (c) {
              return '<div class="kit-falta-item"><b>Carga ' + esc(c.carga) + '</b>' +
                c.itens.map(function (it) {
                  return '<div>' + htmlNomeMaquina(it.d.produto) +
                    ' <span class="muted small">(linha ' + esc(it.d.linha) + ')</span>' +
                    (pode ? '<br><button class="btn primary" type="button" data-rem="' + it.i + '">Remanejar para esta carga</button>' : '') +
                    '</div>';
                }).join('') +
              '</div>';
            }).join('');
        }).join('');
      setBotoesSobra(estado.sobOcupado);
    }

    /* baixa de 1 unidade na sobra + marca KIT na linha escolhida */
    function remanejarSobra(idx) {
      var cod = estado.sobAlvo;
      var d = estado.sobDest && estado.sobDest[idx];
      if (!cod || !d) return;
      if (!podeEditar()) { toast('Seu usuário não pode editar este módulo', 'err'); return; }
      if (estado.sobOcupado) return;
      if (saldoSobra(cod) < 1) { toast('Este kit não tem saldo para remanejar', 'err'); return; }
      var rot = 'carga ' + (d.carga || '?') + ' (' + d.aba + ', linha ' + d.linha + ')';
      if (!window.confirm('Remanejar 1 unidade do kit ' + cod + ' para a ' + rot + '?\n\nIsso marca KIT na planilha.')) return;
      estado.sobOcupado = true;
      setBotoesSobra(true);
      Promise.resolve().then(function () {
        return nv().kitsSobraRemanejar({
          kit: cod, aba: d.aba, linha: d.linha, carga: d.carga, produto: d.produto, usuario: operador()
        });
      }).then(function (r) {
        /* a aba Kits passa a mostrar a carga como liberada na próxima leitura */
        cacheAba = {};
        estado.t = 0;
        toast('Kit ' + cod + ' remanejado para a ' + rot + '. Saldo: ' + (r && r.saldo != null ? r.saldo : '?'), 'ok');
      })['catch'](function (e) {
        toast(msgErro(e), 'err');
      }).then(function () {
        estado.sobOcupado = false;
        setBotoesSobra(false);
        return carregarSobras(true, false);
      }).then(function () {
        if (estado.sobAlvo === cod) pintarSobra(cod);
      });
    }

    function abrirSobra(cod) {
      estado.sobAlvo = cod;
      $(id + 'SobMQtd').value = '1';
      $(id + 'SobMObs').value = '';
      pintarSobra(cod);
      $(id + 'SheetSobra').classList.add('open');
    }

    function moverDaJanela(acao) {
      var cod = estado.sobAlvo;
      var qtd = Number($(id + 'SobMQtd').value);
      var minimo = acao === 'ajuste' ? 0 : 1;
      if (!cod) return;
      if (!isFinite(qtd) || qtd < minimo || Math.floor(qtd) !== qtd) {
        toast('Quantidade inválida (inteiro de ' + minimo + ' ou mais)', 'err');
        return;
      }
      if (acao === 'baixa' && qtd > saldoSobra(cod)) { toast('Baixa maior que o saldo atual', 'err'); return; }
      executarSobra(cod, acao, qtd, ($(id + 'SobMObs').value || '').trim()).then(function (ok) {
        if (ok && estado.sobAlvo === cod) { $(id + 'SobMObs').value = ''; pintarSobra(cod); }
      });
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
      var podeEditarFalta = pode && l.estado !== 'separado';
      var fh = fs.length ? fs.map(function (f) {
        var q = fmtQtd(f.qtd);
        return '<div class="kit-falta-item"><b>' + esc(f.codigo) + '</b>' +
          (q ? '<span class="kit-falta-qtd">faltam ' + esc(q) + '</span>' : '') +
          '<span class="muted small">' + (f.criado_por ? esc(f.criado_por) + ' - ' : '') +
          esc(f.criado_em ? P.fmtDataHora(f.criado_em) : 'agora') + '</span>' +
          (podeEditarFalta
            ? '<button class="btn ghost kit-falta-edit" type="button" data-falta-edit="' + esc(f.falta_id) + '">Editar</button>'
            : '') +
          '</div>';
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
      estado.editando = null;
      modoFormFalta(false);
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

    /* abre o formulário preenchido com os dados da falta para corrigir */
    function abrirEditarFalta(faltaId) {
      var l = estado.alvo;
      var F = window.ModuloFaltas;
      if (!l || !podeEditar() || l.estado === 'separado') return;
      if (!F) { toast('Módulo de faltas indisponível', 'err'); return; }
      var fid = String(faltaId);
      var vinc = faltasDe(l).filter(function (f) { return String(f.falta_id) === fid; })[0];
      if (!vinc) return;

      F.obterFalta(fid).then(function (f) {
        if (!f) { toast('Falta não encontrada no módulo de faltas', 'err'); return; }
        $(id + 'FCodigo').value = f.codigo;
        $(id + 'FNome').value = f.nome || '';
        var propria = (vinc.qtd != null) ? Number(vinc.qtd) : f.qtd;
        $(id + 'FQtd').value = String(propria);
        $(id + 'FDica').textContent = 'A quantidade é só deste kit. O módulo Faltas mostra a soma de todos os kits.';
        $(id + 'FLista').innerHTML = '';
        estado.nomeAuto = false;
        estado.editando = {
          falta_id: fid, codigo: f.codigo, aba: estado.aba, linha: l.linha,
          carga: l.carga, produto: l.produto, own: propria, total: f.qtd
        };
        modoFormFalta(true);
        definirAlmFalta(f.almox);
        $(id + 'FaltaKit').textContent = (l.carga ? l.carga + ' - ' : '') + (l.produto || '');
        $(id + 'SheetFalta').classList.add('open');
        setTimeout(function () { var c = $(id + 'FCodigo'); if (c) c.focus(); }, 120);
      })['catch'](function (e) {
        toast((e && e.message) || 'Falha ao abrir a falta', 'err');
      });
    }

    /* acerta codigo/qtd da falta em todos os caches locais */
    /* o codigo vale para todos os kits da falta; a quantidade so para o
       kit (aba + linha) informado */
    function ehDoKit(f, aba, linha) {
      return f.linha === linha && (f.aba == null || f.aba === aba);
    }

    function atualizarFaltaLocal(fid, codigo, qtd, aba, linha) {
      function acerta(lista) {
        (lista || []).forEach(function (f) {
          if (String(f.falta_id) !== String(fid)) return;
          f.codigo = codigo;
          if (ehDoKit(f, aba, linha)) f.qtd = qtd;
        });
      }
      Object.keys(cacheAba).forEach(function (a) { acerta(cacheAba[a].faltas); });
      Object.keys(estado.faltas || {}).forEach(function (k) { acerta(estado.faltas[k]); });
    }

    /* sem aba/linha: tira a falta de todos os kits; com aba/linha: so daquele kit */
    function removerFaltaLocal(fid, aba, linha) {
      function sem(lista) {
        return (lista || []).filter(function (f) {
          if (String(f.falta_id) !== String(fid)) return true;
          return aba != null && !ehDoKit(f, aba, linha);
        });
      }
      Object.keys(cacheAba).forEach(function (a) {
        var c = cacheAba[a];
        c.faltas = sem(c.faltas);
        if (a === estado.aba) estado.faltas = agruparFaltas(c.faltas, c.linhas);
      });
      if (!cacheAba[estado.aba]) {
        Object.keys(estado.faltas || {}).forEach(function (k) { estado.faltas[k] = sem(estado.faltas[k]); });
      }
    }

    function fimEdicao(btn, texto) {
      estado.ocupado = false;
      btn.disabled = false;
      btn.textContent = texto;
      $(id + 'FExcluir').disabled = false;
    }

    /* a falta de um kit passou para outro componente: o vinculo troca de falta */
    function trocarFaltaLocal(fidAntigo, aba, linha, fidNovo, codigo, qtd) {
      function troca(lista) {
        (lista || []).forEach(function (f) {
          if (String(f.falta_id) === String(fidAntigo) && ehDoKit(f, aba, linha)) {
            f.falta_id = String(fidNovo);
            f.codigo = codigo;
            f.qtd = qtd;
          }
        });
      }
      Object.keys(cacheAba).forEach(function (a) { troca(cacheAba[a].faltas); });
      Object.keys(estado.faltas || {}).forEach(function (k) { troca(estado.faltas[k]); });
    }

    /* A falta do modulo Faltas e a SOMA de todos os kits (uma linha por
       codigo + almoxarifado). A quantidade de cada kit mora no vinculo
       (kits_faltas.qtd). Editar um kit mexe so na parte dele:
       outros = total da falta - parte deste kit. */
    function salvarEdicaoFalta() {
      if (estado.ocupado || !estado.editando) return;
      var F = window.ModuloFaltas;
      if (!F) { toast('Módulo de faltas indisponível', 'err'); return; }
      var ed = estado.editando;
      var codigo = $(id + 'FCodigo').value.trim();
      var nome = $(id + 'FNome').value.trim();
      var qtd = Number(String($(id + 'FQtd').value).replace(',', '.'));
      if (!codigo) { toast('Digite o código do componente', 'err'); return; }
      if (!(qtd >= 1)) { toast('Quantidade deve ser 1 ou mais', 'err'); return; }

      var btn = $(id + 'FSalvar');
      estado.ocupado = true;
      btn.disabled = true;
      $(id + 'FExcluir').disabled = true;
      btn.textContent = 'Salvando...';

      var chave = { aba: ed.aba, linha: ed.linha, falta_id: ed.falta_id };

      F.obterFalta(ed.falta_id).then(function (atual) {
        if (!atual) throw new Error('Falta não encontrada no módulo de faltas');
        var N = nv();
        if (!N) throw new Error('Nuvem indisponível');

        var total = Number(atual.qtd) || 0;
        var propria = Math.min(Number(ed.own) || total, total);
        var outros = total - propria;
        var mesmoItem = codigo.toUpperCase() === String(atual.codigo).toUpperCase() &&
          estado.almFalta === atual.almox;

        /* grava a quantidade deste kit no vinculo; devolve texto de erro ou null */
        function gravarQtd(fid) {
          return N.kitsFaltaDefinirQtd({ aba: ed.aba, linha: ed.linha, falta_id: fid, qtd: qtd })
            .then(function () { return null; }, function (e) { return msgErro(e); });
        }

        /* so este kit tem a falta: edita a falta inteira */
        if (outros <= 0) {
          return F.editarExterno({
            id: ed.falta_id, codigo: codigo, nome: nome, qtd: qtd, almox: estado.almFalta
          }).then(function (r) {
            var p = (r.codigo === ed.codigo)
              ? Promise.resolve()
              : N.kitsFaltaAtualizarCodigo(ed.falta_id, r.codigo);
            return p.then(function () { return gravarQtd(ed.falta_id); }, function (e) { return msgErro(e); })
              .then(function (erro) {
                return { codigo: r.codigo, falta_id: ed.falta_id, nuvem: r.nuvem, erroNuvem: r.erroNuvem, erro: erro };
              });
          });
        }

        /* falta dividida com outros kits, mesmo componente: so muda a parte deste kit */
        if (mesmoItem) {
          return F.editarExterno({
            id: ed.falta_id, codigo: atual.codigo, nome: nome || atual.nome,
            qtd: outros + qtd, almox: atual.almox
          }).then(function (r) {
            return gravarQtd(ed.falta_id).then(function (erro) {
              return { codigo: r.codigo, falta_id: ed.falta_id, nuvem: r.nuvem, erroNuvem: r.erroNuvem, erro: erro };
            });
          });
        }

        /* falta dividida e o kit trocou de componente: sai da falta antiga
           (so a parte dele), entra na do novo componente e religa */
        var novo;
        return F.registrarExterno({
          codigo: codigo, nome: nome, qtd: qtd, almox: estado.almFalta, origem: 'kits'
        }).then(function (r2) {
          novo = r2;
          return N.kitsFaltaVincular({
            aba: ed.aba, linha: ed.linha, carga: ed.carga, produto: ed.produto,
            falta_id: String(r2.id), codigo: r2.codigo, criado_por: operador()
          }).then(null, function (e) {
            /* nao conseguiu ligar: desfaz a soma na falta nova */
            var desfazer = (novo.qtd - qtd >= 1)
              ? F.editarExterno({ id: novo.id, codigo: novo.codigo, nome: novo.nome, qtd: novo.qtd - qtd, almox: novo.almox })
              : F.excluirExterno({ id: novo.id });
            return desfazer.then(null, function () {}).then(function () { throw e; });
          });
        }).then(function () {
          return gravarQtd(String(novo.id));
        }).then(function (erro) {
          return N.kitsFaltaDesvincularKit(chave).then(function () { return erro; }, function (e) {
            return erro || msgErro(e);
          });
        }).then(function (erro) {
          return F.editarExterno({
            id: ed.falta_id, codigo: atual.codigo, nome: atual.nome, qtd: outros, almox: atual.almox
          }).then(function (r) {
            return {
              codigo: novo.codigo, falta_id: String(novo.id), trocou: true,
              nuvem: novo.nuvem !== false && r.nuvem !== false,
              erroNuvem: novo.erroNuvem || r.erroNuvem, erro: erro
            };
          });
        });
      }).then(function (res) {
        if (res.trocou) trocarFaltaLocal(ed.falta_id, ed.aba, ed.linha, res.falta_id, res.codigo, qtd);
        else atualizarFaltaLocal(res.falta_id, res.codigo, qtd, ed.aba, ed.linha);
        if (res.erro) {
          toast('Falta salva, mas a quantidade do kit não foi atualizada: ' + res.erro, 'err');
        } else if (res.nuvem === false) {
          toast('Falta salva neste aparelho; falhou na nuvem: ' + (res.erroNuvem || 'sem conexão'), 'err');
        } else {
          toast('Falta atualizada', 'ok');
        }
        fecharFormFalta();
        pintarDetalhe();
        renderLista();
      })['catch'](function (e) {
        toast((e && e.message) || 'Falha ao editar a falta', 'err');
      }).then(function () { fimEdicao(btn, 'Salvar alterações'); });
    }

    function excluirFaltaEditando() {
      if (estado.ocupado || !estado.editando) return;
      var F = window.ModuloFaltas;
      if (!F) { toast('Módulo de faltas indisponível', 'err'); return; }
      var ed = estado.editando;
      var dividida = (Number(ed.total) || 0) - (Number(ed.own) || 0) > 0;
      var aviso = dividida
        ? 'Excluir a falta de ' + ed.codigo + ' deste kit? Ela continua nos outros kits; só a parte deste kit sai do módulo Faltas.'
        : 'Excluir a falta de ' + ed.codigo + '? Ela sai do módulo Faltas e do kit.';
      if (!window.confirm(aviso)) return;

      var btn = $(id + 'FSalvar');
      estado.ocupado = true;
      btn.disabled = true;
      $(id + 'FExcluir').disabled = true;

      F.obterFalta(ed.falta_id).then(function (atual) {
        /* ja nao existe: so limpa o kit */
        if (!atual) return { r: { nuvem: true }, tudo: true };

        var total = Number(atual.qtd) || 0;
        var propria = Math.min(Number(ed.own) || total, total);
        var outros = total - propria;

        /* so este kit tinha a falta: apaga a falta inteira */
        if (outros <= 0) {
          return F.excluirExterno({ id: ed.falta_id }).then(function (r) { return { r: r, tudo: true }; });
        }

        /* dividida com outros kits: tira so a parte deste kit */
        var N = nv();
        if (!N) throw new Error('Nuvem indisponível');
        return F.editarExterno({
          id: ed.falta_id, codigo: atual.codigo, nome: atual.nome, qtd: outros, almox: atual.almox
        }).then(function (r) {
          return N.kitsFaltaDesvincularKit({ aba: ed.aba, linha: ed.linha, falta_id: ed.falta_id }).then(function () {
            return { r: r, tudo: false };
          }, function (e) {
            throw new Error('Quantidade tirada da falta, mas o kit continua ligado: ' + msgErro(e));
          });
        });
      }).then(function (res) {
        if (res.tudo) removerFaltaLocal(ed.falta_id);
        else removerFaltaLocal(ed.falta_id, ed.aba, ed.linha);
        if (res.r.nuvem === false) {
          toast('Falta excluída neste aparelho; falhou na nuvem: ' + (res.r.erroNuvem || 'sem conexão'), 'err');
        } else {
          toast('Falta excluída', 'ok');
        }
        fecharFormFalta();
        pintarDetalhe();
        renderLista();
      })['catch'](function (e) {
        toast((e && e.message) || 'Falha ao excluir a falta', 'err');
      }).then(function () { fimEdicao(btn, 'Salvar alterações'); });
    }

    function salvarFalta() {
      if (estado.editando) { salvarEdicaoFalta(); return; }
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
        /* r.qtd e o total da falta (soma de todos os kits); cada kit guarda
           a sua parte no vinculo */
        var vinc = faltasDe(l).filter(function (f) { return String(f.falta_id) === fid; })[0];

        function gravarQtd(propria) {
          return Promise.resolve().then(function () {
            return nv().kitsFaltaDefinirQtd({ aba: aba, linha: l.linha, falta_id: fid, qtd: propria });
          }).then(function () { return null; }, function (e) { return msgErro(e); });
        }

        /* este kit ja tinha essa falta: soma so na parte dele */
        if (vinc) {
          var antes = (Number(r.qtd) || 0) - qtd;
          var soma = (vinc.qtd != null ? Number(vinc.qtd) : antes) + qtd;
          return gravarQtd(soma).then(function (erro) {
            if (erro) return { r: r, vinculo: 'erroqtd', erro: erro };
            atualizarFaltaLocal(fid, r.codigo, soma, aba, l.linha);
            return { r: r, vinculo: 'soma' };
          });
        }

        return Promise.resolve().then(function () {
          return nv().kitsFaltaVincular({
            aba: aba, linha: l.linha, carga: l.carga, produto: l.produto,
            falta_id: fid, codigo: r.codigo, criado_por: operador()
          });
        }).then(function () {
          return gravarQtd(qtd).then(function (erro) {
            adicionarFaltaLocal(aba, l, fid, r.codigo, erro ? (r.qtd != null ? r.qtd : qtd) : qtd);
            return erro ? { r: r, vinculo: 'erroqtd', erro: erro } : { r: r, vinculo: 'ok' };
          });
        }, function (e) {
          return { r: r, vinculo: 'erro', erro: msgErro(e) };
        });
      }).then(function (res) {
        if (res.vinculo === 'erro') {
          toast('Falta registrada, mas sem vínculo com o kit: ' + res.erro, 'err');
        } else if (res.vinculo === 'erroqtd') {
          toast('Falta registrada, mas a quantidade do kit não foi salva (rode o SQL patch_kits_qtd_por_kit): ' + res.erro, 'err');
        } else {
          toast(res.vinculo === 'soma' ? 'Quantidade somada à falta deste kit' : 'Falta registrada e vinculada ao kit', 'ok');
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

      /* atualização automática: a cada AUTO_MS e ao voltar para a aba do navegador */
      setInterval(autoAtualizar, AUTO_MS);
      document.addEventListener('visibilitychange', autoAtualizar);

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
        var be = ev.target.closest('[data-falta-edit]');
        if (be) { abrirEditarFalta(be.getAttribute('data-falta-edit')); return; }
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
      $(id + 'FExcluir').addEventListener('click', excluirFaltaEditando);

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

      /* ---------- sobras ---------- */
      var so = $(id + 'SheetSobra');
      $(id + 'SobAtualizar').addEventListener('click', function () { carregarSobras(true, true); });
      var sn = $(id + 'SheetSobNova');
      $(id + 'SobAbrir').addEventListener('click', abrirNovaSobra);
      $(id + 'SobCancelar').addEventListener('click', function () { sn.classList.remove('open'); });
      sn.addEventListener('click', function (ev) {
        if (ev.target === sn || ev.target.closest('.janela-x')) sn.classList.remove('open');
      });
      $(id + 'SobKit').addEventListener('input', atualizarInfoSobra);
      $(id + 'SobRegistrar').addEventListener('click', registrarSobra);
      $(id + 'SobQtd').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); registrarSobra(); }
      });
      $(id + 'SobBusca').addEventListener('input', function (ev) {
        var v = ev.target.value;
        clearTimeout(tBuscaSob);
        tBuscaSob = setTimeout(function () { estado.sobBusca = v; renderSobras(); }, 150);
      });
      $(id + 'SobItens').addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-sobra]');
        if (b) abrirSobra(b.getAttribute('data-sobra'));
      });
      so.addEventListener('click', function (ev) {
        if (ev.target === so || ev.target.closest('.janela-x')) so.classList.remove('open');
      });
      $(id + 'SobSomar').addEventListener('click', function () { moverDaJanela('entrada'); });
      $(id + 'SobBaixa').addEventListener('click', function () { moverDaJanela('baixa'); });
      $(id + 'SobDefinir').addEventListener('click', function () { moverDaJanela('ajuste'); });
      $(id + 'SobDest').addEventListener('click', function (ev) {
        var b = ev.target.closest('button[data-rem]');
        if (b) remanejarSobra(Number(b.getAttribute('data-rem')));
      });

      /* Esc fecha a janela que estiver por cima (PC) */
      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') return;
        if (sn.classList.contains('open')) { sn.classList.remove('open'); return; }
        if (so.classList.contains('open')) { so.classList.remove('open'); return; }
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
        else if (nome === id + '-sobras') { renderSobras(); carregarSobras(false, false); }
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
