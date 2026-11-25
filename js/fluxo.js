/* =========================================================
   MODULO FLUXO DE PRODUCAO (js/fluxo.js)
   Producao por setor, lida do Supabase (so leitura):
   fluxo_producao (ja agregada) e fluxo_fontes (url do web app
   de cada planilha e ultima sincronizacao).
   Aba "Dia": um card por setor com o total; clicar expande as
   maquinas (somadas) e o detalhe por operador.
   Aba "Dashboard": graficos por setor, evolucao diaria e maquinas
   somadas, com filtro de dia, semana ou mes e de setor.
   O botao "Atualizar" chama o /exec de cada planilha para o Apps
   Script ressincronizar e depois recarrega.
   ========================================================= */
window.ModuloFluxo = (function () {
  'use strict';

  /* ordem do fluxo da fábrica (cor fixa por setor nos gráficos) */
  var SETORES = [
    { k: 'corte', n: 'Corte', c: '#ff8a1f' },
    { k: 'solda', n: 'Solda', c: '#ffc542' },
    { k: 'banho', n: 'Banho', c: '#4dabf7' },
    { k: 'pintura', n: 'Pintura', c: '#b197fc' },
    { k: 'pre_montagem', n: 'Pré-montagem', c: '#28c76f' },
    { k: 'montagem_final', n: 'Montagem final', c: '#ff6b9a' }
  ];
  var COR_OUTRO = '#8fa3b8';
  var MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho',
    'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  var SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  var TOP_MAQ = 12;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoDia(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dataDe(iso) { var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function somaDias(iso, n) { var d = dataDe(iso); d.setDate(d.getDate() + n); return isoDia(d); }
  function somaMeses(iso, n) {
    var d = dataDe(iso), alvo = new Date(d.getFullYear(), d.getMonth() + n, 1);
    var ult = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
    alvo.setDate(Math.min(d.getDate(), ult));       // 31/01 + 1 mês = 28 ou 29/02
    return isoDia(alvo);
  }
  function br(iso) { var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function dataHora(t) {
    var d = new Date(t);
    if (isNaN(d)) return '';
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function soma(ls) {
    var t = 0;
    for (var i = 0; i < ls.length; i++) t += Number(ls[i].qtd) || 0;
    return t;
  }
  function pct(v, max) { return max > 0 && v > 0 ? Math.max(1, v / max * 100) : 0; }
  function corSetor(k) {
    for (var i = 0; i < SETORES.length; i++) if (SETORES[i].k === k) return SETORES[i].c;
    return COR_OUTRO;
  }
  /* SETORES + setores novos que aparecerem no banco (não somem do total) */
  function setoresDe(linhas) {
    var ls = SETORES.slice();
    linhas.forEach(function (r) {
      if (!ls.some(function (s) { return s.k === r.setor; })) ls.push({ k: r.setor, n: r.setor || '(sem setor)', c: COR_OUTRO });
    });
    return ls;
  }
  function porSetor(linhas) {
    var por = {};
    linhas.forEach(function (r) { (por[r.setor] = por[r.setor] || []).push(r); });
    return por;
  }
  /* soma por máquina (cod + nome), maior primeiro */
  function maquinasDe(ls) {
    var m = {}, out = [];
    ls.forEach(function (r) {
      var ch = (r.cod || '') + '\u0001' + (r.maquina || '');
      if (!m[ch]) { m[ch] = { cod: r.cod || '', maquina: r.maquina || '', qtd: 0 }; out.push(m[ch]); }
      m[ch].qtd += Number(r.qtd) || 0;
    });
    return out.sort(function (a, b) {
      return b.qtd - a.qtd || a.maquina.localeCompare(b.maquina, 'pt-BR') || a.cod.localeCompare(b.cod, 'pt-BR');
    });
  }
  function rotuloMaq(m) { return (m.cod ? m.cod + ' - ' : '') + (m.maquina || '-'); }

  /* intervalo [de, ate] do filtro; semana = segunda a domingo */
  function periodo(modo, ref) {
    var d = dataDe(ref);
    if (modo === 'dia') return { de: ref, ate: ref, rotulo: br(ref) };
    if (modo === 'semana') {
      var ini = somaDias(ref, -((d.getDay() + 6) % 7)), fim = somaDias(ini, 6);
      return { de: ini, ate: fim, rotulo: br(ini).slice(0, 5) + ' a ' + br(fim) };
    }
    var de = isoDia(new Date(d.getFullYear(), d.getMonth(), 1));
    var ate = isoDia(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    return { de: de, ate: ate, rotulo: MESES[d.getMonth()] + ' de ' + d.getFullYear() };
  }
  function diasEntre(de, ate) {
    var out = [];
    for (var x = de; x <= ate; x = somaDias(x, 1)) out.push(x);
    return out;
  }

  function criarInstancia(cfg) {
    var P = window.PCP;
    var $ = P.$, esc = P.esc, toast = P.toast, num = P.fmtNum;
    var id = cfg.id;                      // 'fluxo'
    var montado = false;
    var estado = {
      dia: isoDia(new Date()), linhas: [], fontes: {}, carregando: false, ocupado: false,
      erro: '', aviso: '', seq: 0, abertos: {}, opsAbertos: {}
    };
    var dash = {
      modo: 'semana', ref: isoDia(new Date()), setor: '', linhas: [], chave: '', cache: {},
      carregando: false, progresso: 0, erro: '', seq: 0, todas: false
    };

    function nv() {
      if (!window.Nuvem) throw new Error('Nuvem nao configurada');
      return window.Nuvem;
    }

    function barraH(rotulo, v, max, cor, extra, attrs) {
      return '<div class="fluxo-hbar"' + (attrs || '') + '><span class="rot" title="' + esc(rotulo) + '">' + esc(rotulo) + '</span>' +
        '<span class="trilho"><i style="width:' + pct(v, max).toFixed(1) + '%;background:' + cor + '"></i></span>' +
        '<span class="val">' + num(v) + (extra ? '<small>' + extra + '</small>' : '') + '</span></div>';
    }

    /* =================== ABA DIA =================== */
    function tabelaMaquinas(ls) {
      var h = '<table class="fluxo-tab"><thead><tr><th>Cód.</th><th>Máquina</th><th class="n">Qtd</th></tr></thead><tbody>';
      maquinasDe(ls).forEach(function (m) {
        h += '<tr><td>' + esc(m.cod || '-') + '</td><td>' + esc(m.maquina || '-') + '</td><td class="n">' + num(m.qtd) + '</td></tr>';
      });
      return h + '</tbody><tfoot><tr><td colspan="2">Total do setor</td><td class="n">' + num(soma(ls)) + '</td></tr></tfoot></table>';
    }

    function tabelaOperadores(ls) {
      var grupos = {}, ordem = [];
      ls.forEach(function (r) {
        var o = r.operador || '(sem operador)';
        if (!grupos[o]) { grupos[o] = []; ordem.push(o); }
        grupos[o].push(r);
      });
      var h = '<table class="fluxo-tab"><thead><tr><th>Operador</th><th>Cód.</th><th>Máquina</th><th class="n">Qtd</th></tr></thead><tbody>';
      ordem.sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); }).forEach(function (o) {
        var g = grupos[o];
        g.forEach(function (r, i) {
          h += '<tr>' + (i ? '' : '<td class="fluxo-op" rowspan="' + (g.length + 1) + '">' + esc(o) + '</td>') +
            '<td>' + esc(r.cod || '-') + '</td><td>' + esc(r.maquina || '-') + '</td><td class="n">' + num(r.qtd) + '</td></tr>';
        });
        h += '<tr class="fluxo-sub"><td colspan="2">Subtotal</td><td class="n">' + num(soma(g)) + '</td></tr>';
      });
      return h + '</tbody></table>';
    }

    function render() {
      var setores = setoresDe(estado.linhas), por = porSetor(estado.linhas);
      var total = soma(estado.linhas);
      var max = 0;
      setores.forEach(function (s) { max = Math.max(max, soma(por[s.k] || [])); });

      $(id + 'Total').textContent = num(total);
      /* barra de participação de cada setor no total do dia */
      $(id + 'Resumo').innerHTML = total > 0 ? '<div class="fluxo-pilha-h">' + setores.map(function (s) {
        var v = soma(por[s.k] || []);
        return v > 0 ? '<i style="width:' + (v / total * 100).toFixed(2) + '%;background:' + s.c + '" title="' +
          esc(s.n) + ': ' + num(v) + '"></i>' : '';
      }).join('') + '</div>' : '';

      $(id + 'Setores').innerHTML = setores.map(function (s) {
        var f = estado.fontes[s.k] || {};
        var ls = por[s.k] || [];
        var v = soma(ls);
        var info = f.sincronizado_em ? 'atualizado em ' + esc(dataHora(f.sincronizado_em)) : 'sem sincronização';
        var temOp = ls.some(function (r) { return r.operador; });
        var corpo = ls.length ?
          tabelaMaquinas(ls) +
          (temOp ? '<details class="fluxo-ops" data-setor="' + esc(s.k) + '"' + (estado.opsAbertos[s.k] ? ' open' : '') +
            '><summary>Ver por operador</summary>' + tabelaOperadores(ls) + '</details>' : '') :
          '<div class="muted small">Sem lançamentos</div>';
        return '<details class="card fluxo-sec" data-setor="' + esc(s.k) + '"' + (estado.abertos[s.k] ? ' open' : '') + '>' +
          '<summary><div class="fluxo-sec-top">' +
          '<span class="fluxo-dot" style="background:' + s.c + '"></span>' +
          '<span class="fluxo-sec-nome">' + esc(s.n) + '<small class="muted">' + info + '</small></span>' +
          '<span class="fluxo-sec-qtd' + (v ? '' : ' zero') + '">' + num(v) + '</span>' +
          '<span class="fluxo-chev" aria-hidden="true">&rsaquo;</span></div>' +
          '<div class="fluxo-barra"><i style="width:' + pct(v, max).toFixed(1) + '%;background:' + s.c + '"></i></div>' +
          (f.erro ? '<div class="kits-status-erro small">' + esc(f.erro) + '</div>' : '') +
          '</summary><div class="fluxo-sec-corpo">' + corpo + '</div></details>';
      }).join('');

      $(id + 'Dia').value = estado.dia;
      $(id + 'Atualizar').disabled = estado.ocupado;
      $(id + 'DAtualizar').disabled = estado.ocupado;
      var st = $(id + 'Status');
      st.className = 'muted small kits-status' + ((estado.erro || estado.aviso) ? ' kits-status-erro' : '');
      st.textContent = estado.ocupado ? 'Atualizando planilhas...' :
        estado.erro ? estado.erro :
        estado.aviso ? estado.aviso :
        estado.carregando ? 'Carregando...' : '';
    }

    function carregar() {
      var seq = ++estado.seq, dia = estado.dia;
      estado.carregando = true; estado.erro = '';
      render();
      return Promise.resolve().then(function () {
        var N = nv();
        return Promise.all([
          N.fluxoDia(dia),
          N.fluxoFontes().then(null, function () { return null; })   // sem fontes: só não mostra a hora
        ]);
      }).then(function (r) {
        if (seq !== estado.seq) return;      // o dia mudou no meio da leitura
        estado.linhas = r[0] || [];
        if (r[1]) {
          estado.fontes = {};
          r[1].forEach(function (f) { estado.fontes[f.setor] = f; });
        }
      }).then(null, function (e) {
        if (seq !== estado.seq) return;
        estado.linhas = [];
        estado.erro = 'Falha ao ler o fluxo: ' + ((e && e.message) || e);
      }).then(function () {
        if (seq !== estado.seq) return;
        estado.carregando = false;
        render();
      });
    }

    function irPara(dia) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || dia === estado.dia) return;
      estado.dia = dia;
      carregar();
    }

    /* =================== ABA DASHBOARD =================== */
    function statusDash() {
      var st = $(id + 'DStatus');
      st.className = 'muted small kits-status' + ((dash.erro || estado.aviso) ? ' kits-status-erro' : '');
      st.textContent = estado.ocupado ? 'Atualizando planilhas...' :
        dash.erro ? dash.erro :
        estado.aviso ? estado.aviso :
        dash.carregando ? 'Carregando...' + (dash.progresso ? ' ' + num(dash.progresso) + ' linhas' : '') : '';
    }

    function graficoSetores(setores, por, total) {
      var max = 0;
      setores.forEach(function (s) { max = Math.max(max, soma(por[s.k] || [])); });
      return '<div class="card"><div class="fluxo-card-tit">Por setor<small class="muted">toque para filtrar</small></div>' +
        setores.map(function (s) {
          var v = soma(por[s.k] || []);
          var p = total > 0 ? Math.round(v / total * 100) + '%' : '';
          return barraH(s.n, v, max, s.c, p, ' role="button" tabindex="0" data-setor="' + esc(s.k) + '"' +
            (dash.setor === s.k ? ' data-sel="1"' : ''));
        }).join('') + '</div>';
    }

    function graficoEvolucao(p, ls, setores) {
      var dias = diasEntre(p.de, p.ate), porDia = {}, max = 0;
      ls.forEach(function (r) {
        var d = porDia[r.data] = porDia[r.data] || { t: 0, s: {} };
        var q = Number(r.qtd) || 0;
        d.t += q; d.s[r.setor] = (d.s[r.setor] || 0) + q;
      });
      dias.forEach(function (x) { if (porDia[x]) max = Math.max(max, porDia[x].t); });
      var semana = dash.modo === 'semana';
      var cols = dias.map(function (x) {
        var d = porDia[x] || { t: 0, s: {} }, dt = dataDe(x), dn = dt.getDate();
        var pilha = setores.map(function (s) {
          var v = d.s[s.k] || 0;
          return v > 0 ? '<i style="height:' + (v / d.t * 100).toFixed(2) + '%;background:' + s.c + '"></i>' : '';
        }).join('');
        var rot = semana ? SEMANA[dt.getDay()] + ' ' + dn : (dn === 1 || dn % 5 === 0 ? String(dn) : '');
        var alt = d.t ? pct(d.t, max).toFixed(1) : '0';
        return '<div class="fluxo-col" title="' + br(x) + ': ' + num(d.t) + '"><div class="area">' +
          '<div class="pilha' + (d.t ? '' : ' zero') + '" style="height:' + alt + '%">' + pilha + '</div>' +
          (semana && d.t ? '<em style="bottom:calc(' + alt + '% + 2px)">' + num(d.t) + '</em>' : '') +
          '</div><small>' + rot + '</small></div>';
      }).join('');
      var usados = setores.filter(function (s) { return ls.some(function (r) { return r.setor === s.k; }); });
      var legenda = usados.length > 1 ? '<div class="fluxo-legenda">' + usados.map(function (s) {
        return '<span><i style="background:' + s.c + '"></i>' + esc(s.n) + '</span>';
      }).join('') + '</div>' : '';
      return '<div class="card"><div class="fluxo-card-tit">Evolução por dia</div><div class="fluxo-cols">' + cols + '</div>' + legenda + '</div>';
    }

    function graficoMaquinas(ls) {
      var maqs = maquinasDe(ls).filter(function (m) { return m.qtd; });
      if (!maqs.length) return '';
      var cor = dash.setor ? corSetor(dash.setor) : 'var(--accent)';
      var mostrar = dash.todas ? maqs : maqs.slice(0, TOP_MAQ);
      var max = maqs[0].qtd;
      return '<div class="card"><div class="fluxo-card-tit">Máquinas (somadas)<small class="muted">' + maqs.length + ' no total</small></div>' +
        mostrar.map(function (m) { return barraH(rotuloMaq(m), m.qtd, max, cor); }).join('') +
        (maqs.length > TOP_MAQ ? '<button type="button" class="pill fluxo-mais" data-acao="todas">' +
          (dash.todas ? 'Mostrar só as ' + TOP_MAQ + ' maiores' : 'Ver todas (' + maqs.length + ')') + '</button>' : '') +
        '</div>';
    }

    function renderDash() {
      var p = periodo(dash.modo, dash.ref);
      var setores = setoresDe(dash.linhas);

      Array.prototype.forEach.call($(id + 'Modo').querySelectorAll('[data-modo]'), function (b) {
        b.classList.toggle('active', b.getAttribute('data-modo') === dash.modo);
      });
      $(id + 'DRef').value = dash.ref;
      $(id + 'DRotulo').textContent = p.rotulo;
      var sel = $(id + 'DSetor');
      sel.innerHTML = '<option value="">Todos os setores</option>' + setores.map(function (s) {
        return '<option value="' + esc(s.k) + '"' + (s.k === dash.setor ? ' selected' : '') + '>' + esc(s.n) + '</option>';
      }).join('');
      statusDash();

      var alvo = $(id + 'DConteudo');
      if (!dash.linhas.length) {
        alvo.innerHTML = dash.carregando || dash.erro ? '' : '<div class="card muted small">Sem lançamentos no período.</div>';
        return;
      }

      var por = porSetor(dash.linhas);
      var totalGeral = soma(dash.linhas);
      var ls = dash.setor ? (por[dash.setor] || []) : dash.linhas;
      var total = soma(ls);
      var diasCom = {};
      ls.forEach(function (r) { if (Number(r.qtd)) diasCom[r.data] = 1; });
      var nDias = Object.keys(diasCom).length;

      var lider = '', liderV = 0;
      if (dash.setor) {
        var m0 = maquinasDe(ls)[0];
        if (m0 && m0.qtd) { lider = rotuloMaq(m0); liderV = m0.qtd; }
      } else {
        setores.forEach(function (s) { var v = soma(por[s.k] || []); if (v > liderV) { liderV = v; lider = s.n; } });
      }

      var kpi = function (rot, val, sub) {
        return '<div class="fluxo-kpi"><span class="muted small">' + rot + '</span><b>' + val + '</b>' +
          (sub ? '<small class="muted">' + sub + '</small>' : '') + '</div>';
      };
      var nomeSel = dash.setor ? (setores.filter(function (s) { return s.k === dash.setor; })[0] || {}).n : '';
      var h = '<div class="fluxo-kpis">' +
        kpi(dash.setor ? 'Total ' + esc(nomeSel) : 'Total geral', num(total),
          dash.setor && totalGeral ? Math.round(total / totalGeral * 100) + '% do total (' + num(totalGeral) + ')' : '') +
        kpi('Média por dia', nDias ? num(Math.round(total / nDias)) : '-', nDias ? 'em ' + nDias + ' dia' + (nDias > 1 ? 's' : '') + ' com produção' : '') +
        kpi(dash.setor ? 'Máquina líder' : 'Setor líder', lider ? '<span class="fluxo-kpi-txt">' + esc(lider) + '</span>' : '-', lider ? num(liderV) : '') +
        kpi('Máquinas diferentes', num(maquinasDe(ls).filter(function (m) { return m.qtd; }).length), '') +
        '</div>';

      h += graficoSetores(setores, por, totalGeral);
      if (dash.modo !== 'dia') h += graficoEvolucao(p, ls, setores);
      h += graficoMaquinas(ls);
      alvo.innerHTML = h;
    }

    function carregarDash() {
      var p = periodo(dash.modo, dash.ref), chave = p.de + '|' + p.ate, seq = ++dash.seq;
      if (dash.chave !== chave) { dash.linhas = []; dash.chave = chave; }
      dash.erro = '';
      if (dash.cache[chave]) {
        dash.linhas = dash.cache[chave]; dash.carregando = false;
        renderDash();
        return Promise.resolve();
      }
      dash.carregando = true; dash.progresso = 0;
      renderDash();
      return Promise.resolve().then(function () {
        return nv().fluxoPeriodo(p.de, p.ate, function (n) {
          if (seq === dash.seq) { dash.progresso = n; statusDash(); }
        });
      }).then(function (ls) {
        if (seq !== dash.seq) return;
        dash.linhas = ls || [];
        dash.cache[chave] = dash.linhas;
      }, function (e) {
        if (seq !== dash.seq) return;
        dash.linhas = [];
        dash.erro = 'Falha ao ler o dashboard: ' + ((e && e.message) || e);
      }).then(function () {
        if (seq !== dash.seq) return;
        dash.carregando = false;
        renderDash();
      });
    }

    function moverDash(n) {
      dash.ref = dash.modo === 'mes' ? somaMeses(dash.ref, n) :
        somaDias(dash.ref, dash.modo === 'semana' ? 7 * n : n);
      carregarDash();
    }

    function filtrarSetor(k) {
      dash.setor = dash.setor === k ? '' : k;
      dash.todas = false;
      renderDash();
    }

    /* pede a cada planilha (Apps Script web app) que ressincronize */
    function atualizar() {
      if (estado.ocupado) return;
      estado.ocupado = true; estado.aviso = ''; estado.erro = '';
      render(); statusDash();
      Promise.resolve().then(function () { return nv().fluxoFontes(); }).then(function (fs) {
        var urls = (fs || []).map(function (f) { return String(f.url || '').trim(); })
          .filter(function (u) { return /\/exec$/.test(u); });
        if (!urls.length) {
          estado.aviso = 'Nenhuma planilha registrada. Abra uma vez o link do web app (/exec) de cada planilha para registrá-la.';
          toast('Nenhuma planilha registrada', 'err');
          return;
        }
        return Promise.allSettled(urls.map(function (u) {
          return fetch(u + '?t=' + Date.now(), { mode: 'no-cors' });
        }));
      }).then(null, function (e) {
        estado.erro = 'Falha ao atualizar: ' + ((e && e.message) || e);
      }).then(function () {
        estado.ocupado = false;
        dash.cache = {};
        carregarDash();
        return carregar();
      });
    }

    /* =================== montagem =================== */
    function montarUI() {
      if (montado) return;
      montado = true;

      var wrap = document.createElement('div');
      wrap.innerHTML = [
        '<section id="view-' + id + '-dia" class="view" data-modulo="' + id + '">',
        '  <div class="kits-topo">',
        '    <button id="' + id + 'Ant" class="pill" type="button" aria-label="Dia anterior">&lsaquo;</button>',
        '    <input id="' + id + 'Dia" type="date" class="kits-select" aria-label="Dia">',
        '    <button id="' + id + 'Prox" class="pill" type="button" aria-label="Próximo dia">&rsaquo;</button>',
        '    <button id="' + id + 'Atualizar" class="pill" type="button">&#8635; Atualizar</button>',
        '  </div>',
        '  <div id="' + id + 'Status" class="muted small kits-status"></div>',
        '  <div class="card"><div class="muted small">Total do dia</div>',
        '    <div id="' + id + 'Total" class="fluxo-total">0</div>',
        '    <div id="' + id + 'Resumo"></div></div>',
        '  <div id="' + id + 'Setores"></div>',
        '</section>',
        '<section id="view-' + id + '-dash" class="view" data-modulo="' + id + '">',
        '  <div class="kits-topo">',
        '    <div id="' + id + 'Modo" class="fluxo-seg" role="group" aria-label="Período">',
        '      <button class="pill" type="button" data-modo="dia">Dia</button>',
        '      <button class="pill" type="button" data-modo="semana">Semana</button>',
        '      <button class="pill" type="button" data-modo="mes">Mês</button>',
        '    </div>',
        '    <button id="' + id + 'DAtualizar" class="pill" type="button">&#8635; Atualizar</button>',
        '  </div>',
        '  <div class="kits-topo">',
        '    <button id="' + id + 'DAnt" class="pill" type="button" aria-label="Período anterior">&lsaquo;</button>',
        '    <input id="' + id + 'DRef" type="date" class="kits-select" aria-label="Data de referência">',
        '    <button id="' + id + 'DProx" class="pill" type="button" aria-label="Próximo período">&rsaquo;</button>',
        '    <select id="' + id + 'DSetor" class="kits-select" aria-label="Setor"></select>',
        '  </div>',
        '  <div id="' + id + 'DRotulo" class="fluxo-rotulo"></div>',
        '  <div id="' + id + 'DStatus" class="muted small kits-status"></div>',
        '  <div id="' + id + 'DConteudo"></div>',
        '</section>'
      ].join('\n');
      var main = $('main');
      while (wrap.firstChild) main.appendChild(wrap.firstChild);

      var nav = document.createElement('nav');
      nav.className = 'tabbar hidden';
      nav.id = 'tabbar-' + id;
      nav.setAttribute('data-modulo', id);
      nav.innerHTML =
        '<button class="tab active" data-view="' + id + '-dia" type="button"><span>&#127981;</span>Dia</button>' +
        '<button class="tab" data-view="' + id + '-dash" type="button"><span>&#128202;</span>Dashboard</button>';
      document.body.appendChild(nav);

      /* abas próprias: o ligarEventos() do app.js já rodou antes destas existirem */
      nav.addEventListener('click', function (ev) {
        var b = ev.target.closest('.tab');
        if (b && P.mostrarView) P.mostrarView(b.dataset.view);
      });

      /* aba Dia */
      $(id + 'Ant').addEventListener('click', function () { irPara(somaDias(estado.dia, -1)); });
      $(id + 'Prox').addEventListener('click', function () { irPara(somaDias(estado.dia, 1)); });
      $(id + 'Dia').addEventListener('change', function (ev) { irPara(ev.target.value); });
      $(id + 'Atualizar').addEventListener('click', atualizar);
      /* lembra quais setores estão abertos (toggle não borbulha: captura) */
      $(id + 'Setores').addEventListener('toggle', function (ev) {
        var el = ev.target, k = el.getAttribute && el.getAttribute('data-setor');
        if (k == null) return;
        if (el.classList.contains('fluxo-sec')) estado.abertos[k] = el.open;
        else if (el.classList.contains('fluxo-ops')) estado.opsAbertos[k] = el.open;
      }, true);

      /* aba Dashboard */
      $(id + 'Modo').addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-modo]');
        if (!b || b.getAttribute('data-modo') === dash.modo) return;
        dash.modo = b.getAttribute('data-modo');
        dash.todas = false;
        carregarDash();
      });
      $(id + 'DAnt').addEventListener('click', function () { moverDash(-1); });
      $(id + 'DProx').addEventListener('click', function () { moverDash(1); });
      $(id + 'DRef').addEventListener('change', function (ev) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.target.value)) return;
        dash.ref = ev.target.value;
        carregarDash();
      });
      $(id + 'DSetor').addEventListener('change', function (ev) {
        dash.setor = ev.target.value; dash.todas = false;
        renderDash();
      });
      $(id + 'DAtualizar').addEventListener('click', atualizar);
      var conteudo = $(id + 'DConteudo');
      conteudo.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-acao="todas"]')) { dash.todas = !dash.todas; renderDash(); return; }
        var b = ev.target.closest('[data-setor]');
        if (b) filtrarSetor(b.getAttribute('data-setor'));
      });
      conteudo.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        var b = ev.target.closest('[data-setor]');
        if (b) { ev.preventDefault(); filtrarSetor(b.getAttribute('data-setor')); }
      });

      render();
      renderDash();
    }

    var promessa = null;
    return {
      cfg: cfg,
      preparar: function () {
        if (!promessa) promessa = Promise.resolve().then(montarUI);
        return promessa;
      },
      aoMostrarView: function (nome) {
        if (!montado) return;
        if (nome === id + '-dia') carregar();
        if (nome === id + '-dash') { dash.cache = {}; carregarDash(); }
      },
      fecharSheets: function () {}
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
    }
  };
})();
