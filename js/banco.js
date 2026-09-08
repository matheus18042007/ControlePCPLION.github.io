/* =========================================================
   BANCO DE DADOS - módulo restrito (só o dono)

   Cada módulo do PCP LION tem o SEU banco SQLite, num
   IndexedDB próprio (js/base.js). Isso é de propósito, mas
   significa que "baixar o banco" pelo Almoxarifado baixa
   só 2 das 10 tabelas do sistema.

   Aqui mora a visão de cima: varre TODOS os IndexedDB de
   TODOS os módulos, lê o sqlite_master de cada um (nada de
   schema hardcoded - o dump acompanha o código sozinho) e
   entrega backup completo em .db, .csv e .sql.

   Também concentra o que é infraestrutura e não operação:
   endereço da nuvem, chave VAPID, estado do push.

   Visível só para quem estiver em MODULOS[banco].dono.
   ========================================================= */
window.ModuloBanco = (function () {
  'use strict';

  var instancia = null;

  function criarInstancia(cfg) {
    var P = window.PCP;
    var $ = P.$, qsa = P.qsa, esc = P.esc, toast = P.toast;

    var id = cfg.id;                       // 'banco'
    var montado = false, promessa = null;
    var SQL = null;
    var inventario = null;                 // cache do último exame

    /* ---------------------------------------------------------
       Quais bancos existem

       Derivado de MODULOS, não de uma lista paralela: módulo
       novo aparece aqui sozinho. A regra de nome do IndexedDB
       é a mesma dos motores (almox é o legado 'almox_pba').
    --------------------------------------------------------- */
    function bancosConhecidos() {
      var mods = window.MODULOS || [];
      return mods.filter(function (m) {
        return m.id !== id;
      }).map(function (m) {
        return {
          modulo: m.id,
          nome: m.nome,
          icone: m.icone,
          idb: (m.id === 'almox') ? 'almox_pba' : 'pcp_' + m.id
        };
      });
    }

    function carregarSQL() {
      if (SQL) return Promise.resolve(SQL);
      return initSqlJs({ locateFile: function (f) { return './vendor/' + f; } })
        .then(function (s) { SQL = s; return s; });
    }

    /* abre o .db de um IndexedDB sem tocar em nada (só leitura) */
    function abrirCopia(idb) {
      return window.PCPDB.get(idb, 'dbfile').then(function (bytes) {
        if (!bytes || !bytes.byteLength) return null;
        try {
          return { db: new SQL.Database(new Uint8Array(bytes)), bytes: bytes };
        } catch (e) {
          return null;
        }
      }).catch(function () { return null; });
    }

    function tabelasDe(db) {
      var out = [];
      var st = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' " +
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      while (st.step()) {
        var r = st.getAsObject();
        var n = 0;
        try { n = escalarDe(db, 'SELECT COUNT(*) FROM "' + r.name + '"'); } catch (e) { n = -1; }
        out.push({ nome: r.name, sql: r.sql, linhas: n });
      }
      st.free();
      return out;
    }

    function indicesDe(db) {
      var out = [];
      var st = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"
      );
      while (st.step()) out.push(st.getAsObject().sql);
      st.free();
      return out;
    }

    function escalarDe(db, sql) {
      var st = db.prepare(sql), v = 0;
      if (st.step()) { var r = st.getAsObject(); v = r[Object.keys(r)[0]]; }
      st.free();
      return v;
    }

    /* O IndexedDB de um modulo so nasce quando o modulo abre pela primeira
       vez. Antes de examinar, acordamos o motor de cada um: assim o backup
       ve o sistema inteiro sem o usuario ter que passear pelas telas. */
    var acordados = null;
    function acordarModulos() {
      if (acordados) return acordados;
      var mods = (window.MODULOS || []).filter(function (m) {
        return m.id !== id && m.pronto && m.tipo;
      });
      acordados = mods.reduce(function (p, m) {
        return p.then(function () {
          var motor = window.motorDoTipo && window.motorDoTipo(m.tipo);
          if (!motor) return null;
          return motor.obter(m).preparar().catch(function () { return null; });
        });
      }, Promise.resolve()).then(function () {
        /* os motores montam as telas deles no DOM; como nao estamos neles,
           escondemos de novo tudo que nao e do Banco de Dados. */
        qsa('[data-modulo]').forEach(function (el) {
          el.classList.toggle('hidden', el.dataset.modulo !== id);
        });
      });
      return acordados;
    }

    /* ---------------------------------------------------------
       Fotos: nao moram no SQLite. Cada modulo guarda no proprio
       IndexedDB, no mesmo kv do .db, em chaves 'foto_<codigo>'
       (data URL jpeg). O .db sozinho NAO leva as imagens.
    --------------------------------------------------------- */
    function chavesFoto(idb) {
      if (!window.PCPDB.keys) return Promise.resolve([]);
      return window.PCPDB.keys(idb).then(function (ks) {
        return ks.filter(function (k) {
          return String(k).indexOf('foto_') === 0;
        });
      }).catch(function () { return []; });
    }

    /* examina todos os bancos e guarda o resultado */
    function examinar() {
      return acordarModulos().then(carregarSQL).then(function () {
        var lista = bancosConhecidos();
        return lista.reduce(function (p, b) {
          return p.then(function (acc) {
            return chavesFoto(b.idb).then(function (fotos) {
              return abrirCopia(b.idb).then(function (c) {
                if (!c) {
                  acc.push({ modulo: b.modulo, nome: b.nome, icone: b.icone,
                             idb: b.idb, vazio: true, tabelas: [], indices: [],
                             fotos: fotos, tamanho: 0 });
                  return acc;
                }
                acc.push({
                  modulo: b.modulo, nome: b.nome, icone: b.icone, idb: b.idb,
                  vazio: false,
                  tabelas: tabelasDe(c.db),
                  indices: indicesDe(c.db),
                  fotos: fotos,
                  tamanho: c.bytes.byteLength
                });
                c.db.close();
                return acc;
              });
            });
          });
        }, Promise.resolve([])).then(function (r) {
          inventario = r;
          return r;
        });
      });
    }

    /* ---------------------------------------------------------
       Downloads
    --------------------------------------------------------- */
    function carimbo() { return P.carimbo(); }

    function paraCsv(linhas) {
      if (!linhas.length) return '';
      var cols = Object.keys(linhas[0]);
      var cel = function (v) {
        if (v == null) return '';
        var s = String(v);
        return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      var out = [cols.join(';')];
      linhas.forEach(function (l) {
        out.push(cols.map(function (c) { return cel(l[c]); }).join(';'));
      });
      return out.join('\r\n');
    }

    /* fila de downloads: o navegador engasga se disparar tudo junto */
    function baixarFila(arquivos) {
      if (!arquivos.length) { toast('Nada para baixar', 'err'); return Promise.resolve(); }
      return arquivos.reduce(function (p, a, i) {
        return p.then(function () {
          return new Promise(function (res) {
            setTimeout(function () {
              P.baixar(a.blob, a.nome);
              progresso((i + 1) + ' de ' + arquivos.length + ' - ' + a.nome);
              res();
            }, i === 0 ? 0 : 350);
          });
        });
      }, Promise.resolve()).then(function () {
        progresso('Pronto: ' + arquivos.length + ' arquivo(s) baixado(s).');
        toast('Backup baixado', 'ok');
      });
    }

    function progresso(txt) {
      var el = $(id + 'Prog');
      if (el) el.textContent = txt || '';
    }

    /* ---------------------------------------------------------
       Nuvem: um CSV por tabela do Supabase (o banco de verdade).
       O IndexedDB local so tem o que este aparelho ja viu; isto aqui
       e o backup do servidor inteiro. Tabelas que nao existem sao
       puladas em silencio - a lista serve para varios projetos.
    --------------------------------------------------------- */
    var TABELAS_NUVEM = [
      'itens', 'movimentacoes',
      'contagem_itens', 'contagem_movimentacoes', 'contagem_fotos',
      'eficiencia_colaboradores', 'eficiencia_dias',
      'faltas', 'faltas_componentes', 'faltas_notif_estado',
      'push_subscriptions'
    ];

    function baixarNuvem() {
      if (!window.Nuvem || !Nuvem.ativa()) {
        toast('Nuvem não configurada', 'err');
        return Promise.resolve();
      }
      var arquivos = [];
      var vazias = [];
      return TABELAS_NUVEM.reduce(function (p, t) {
        return p.then(function () {
          progresso('Baixando ' + t + '...');
          return Nuvem.puxarTabela(t).then(function (linhas) {
            if (!linhas || !linhas.length) { vazias.push(t); return; }
            arquivos.push({
              blob: new Blob(['﻿' + paraCsv(linhas)], { type: 'text/csv;charset=utf-8' }),
              nome: 'nuvem_' + t + '_' + carimbo() + '.csv'
            });
          }).catch(function () { vazias.push(t); });
        });
      }, Promise.resolve()).then(function () {
        if (!arquivos.length) { progresso(''); toast('Nada veio da nuvem', 'err'); return; }
        progresso(arquivos.length + ' tabela(s); sem dados: ' + (vazias.join(', ') || '-'));
        return baixarFila(arquivos);
      }).catch(erro);
    }

    function erro(e) {
      progresso('');
      toast('Falhou: ' + (e && e.message ? e.message : e), 'err');
    }

    /* ---------------------------------------------------------
       Telas
    --------------------------------------------------------- */
    function montarUI() {
      if (montado) return;
      montado = true;
      var main = $('main');

      var wrap = document.createElement('div');
      wrap.innerHTML = [
        /* ---------- ABA 1: BACKUP ---------- */
        '<section id="view-' + id + '-backup" class="view" data-modulo="' + id + '">',
        '  <div class="card">',
        '    <h3>Backup da nuvem</h3>',
        '    <p class="muted small">Um CSV por tabela do servidor (Supabase) - dados de',
        '       todos os módulos e todos os aparelhos, inclusive as fotos das carenagens',
        '       (<code>contagem_fotos</code>). Nada sai do cache deste aparelho.',
        '       São vários downloads seguidos - libere se o navegador perguntar.</p>',
        '    <button id="' + id + 'BtnTudo" class="btn primary block" type="button">&#11015; Baixar TUDO</button>',
        '    <p class="muted small" id="' + id + 'Prog"></p>',
        '  </div>',
        '  <div class="card">',
        '    <h3>O que existe hoje</h3>',
        '    <button id="' + id + 'BtnExaminar" class="pill" type="button">&#8635; Examinar bancos</button>',
        '    <div id="' + id + 'Inv" class="list"></div>',
        '  </div>',
        '</section>',

        /* ---------- ABA 2: NUVEM ---------- */
        '<section id="view-' + id + '-nuvem" class="view" data-modulo="' + id + '">',
        '  <div class="card">',
        '    <h3>Servidor (Supabase)</h3>',
        '    <div class="kv"><span>Endereço</span><b id="' + id + 'NuvUrl">-</b></div>',
        '    <div class="kv"><span>Chave anon</span><b id="' + id + 'NuvKey">-</b></div>',
        '    <div class="kv"><span>Situação</span><b id="' + id + 'NuvEstado">-</b></div>',
        '    <div class="kv"><span>Este aparelho</span><b id="' + id + 'NuvAp">-</b></div>',
        '    <button id="' + id + 'BtnRevelar" class="pill" type="button">&#128065; Revelar</button>',
        '    <button id="' + id + 'BtnTestar" class="pill" type="button">&#8635; Testar conexão</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Trocar o endereço / a chave</h3>',
        '    <p class="muted small">A URL e a chave moram <b>cifradas</b> no cofre',
        '       (<code>js/usuarios.js</code>), embrulhadas na senha de cada usuário.',
        '       Trocar aqui dentro do app não adiantaria: o arquivo novo precisa ser',
        '       publicado no servidor para valer para todo mundo.</p>',
        '    <p class="muted small">A tela de administração faz a troca e gera o arquivo',
        '       para você substituir e publicar. É lá também que se cadastra usuário',
        '       e se troca senha.</p>',
        '    <a class="btn ghost block" href="./admin.html">&#9881; Abrir administração do cofre</a>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Usuários do cofre</h3>',
        '    <div id="' + id + 'Users" class="list"></div>',
        '  </div>',
        '</section>',

        /* ---------- ABA 3: NOTIFICAÇÕES ---------- */
        '<section id="view-' + id + '-push" class="view" data-modulo="' + id + '">',
        '  <div class="card">',
        '    <h3>Notificações neste aparelho</h3>',
        '    <div class="kv"><span>Estado</span><b id="' + id + 'PushEstado">-</b></div>',
        '    <button id="' + id + 'PushAtivar" class="btn primary block" type="button">&#128276; Ativar</button>',
        '    <button id="' + id + 'PushDesativar" class="btn ghost block" type="button">Desativar</button>',
        '  </div>',
        '  <div class="card">',
        '    <h3>Chave VAPID</h3>',
        '    <p class="muted small">A chave <b>pública</b> vai no ar em toda requisição de push,',
        '       então fica em texto puro no <code>js/push.js</code>. A <b>privada</b> é secret da',
        '       Edge Function <code>faltas-notificar</code> e não passa por aqui.</p>',
        '    <div class="kv"><span>Configurada</span><b id="' + id + 'VapidOk">-</b></div>',
        '    <p class="muted small mono" id="' + id + 'Vapid" style="word-break:break-all"></p>',
        '    <p class="muted small">Para trocar: <code>npx web-push generate-vapid-keys</code>,',
        '       a pública em <code>js/push.js</code>, a privada como secret da Edge Function.</p>',
        '  </div>',
        '</section>'
      ].join('\n');
      while (wrap.firstChild) main.appendChild(wrap.firstChild);

      var nav = document.createElement('nav');
      nav.className = 'tabbar hidden';
      nav.id = 'tabbar-' + id;
      nav.setAttribute('data-modulo', id);
      nav.innerHTML = [
        '<button class="tab active" data-view="' + id + '-backup" type="button"><span>&#128190;</span>Backup</button>',
        '<button class="tab" data-view="' + id + '-nuvem" type="button"><span>&#9729;</span>Nuvem</button>',
        '<button class="tab" data-view="' + id + '-push" type="button"><span>&#128276;</span>Avisos</button>'
      ].join('');
      document.body.appendChild(nav);

      ligarEventos();
    }

    /* Um único listener delegado no documento.

       Antes era um addEventListener por botão: se qualquer id
       nao existisse na hora da montagem, a linha estourava e
       TODOS os botoes seguintes ficavam mortos, sem erro
       visivel. Delegado, cada botao responde por si. */
    function ligarEventos() {
      qsa('#tabbar-' + id + ' .tab').forEach(function (t) {
        t.addEventListener('click', function () { P.mostrarView(t.dataset.view); });
      });

      var acoes = {
        BtnTudo: baixarNuvem,
        BtnExaminar: renderInventario,
        BtnRevelar: function () { revelado = !revelado; renderNuvem(); },
        BtnTestar: function () {
          var el = $(id + 'NuvEstado');
          if (el) el.textContent = 'testando...';
          Nuvem.testar().then(function () {
            if (el) el.textContent = 'conectado';
            toast('Conexão OK', 'ok');
          }).catch(function (e) {
            if (el) el.textContent = 'falhou';
            toast('Sem conexão: ' + e.message, 'err');
          });
        },
        PushAtivar: function () {
          Push.ativar().then(function (m) { toast(m, 'ok'); renderPush(); })
            .catch(function (e) { toast(e.message, 'err'); renderPush(); });
        },
        PushDesativar: function () {
          Push.desativar().then(function () { toast('Desativado', 'ok'); renderPush(); })
            .catch(function (e) { toast(e.message, 'err'); });
        }
      };

      document.addEventListener('click', function (ev) {
        var el = ev.target;
        while (el && el.tagName !== 'BUTTON') el = el.parentNode;
        if (!el || !el.id || el.id.indexOf(id) !== 0) return;
        var f = acoes[el.id.slice(id.length)];
        if (!f) return;
        try { f(); } catch (e) { toast('Falhou: ' + (e && e.message ? e.message : e), 'err'); }
      });
    }

    var revelado = false;

    function mascarar(s) {
      s = String(s || '');
      if (!s) return '-';
      if (revelado) return s;
      return s.slice(0, 6) + '...' + s.slice(-4);
    }

    function renderInventario() {
      var box = $(id + 'Inv');
      box.innerHTML = '<p class="muted small">Lendo...</p>';
      examinar().then(function (inv) {
        if (!inv.length) {
          box.innerHTML = '<p class="muted small warn">Nenhum módulo encontrado ' +
            '(a lista MODULOS não chegou aqui).</p>';
          return;
        }
        var total = 0;
        var html = inv.map(function (b) {
          if (b.vazio) {
            return '<div class="card"><b>' + b.icone + ' ' + esc(b.nome) + '</b>' +
                   '<p class="muted small">banco ainda não criado neste aparelho</p></div>';
          }
          var linhas = b.tabelas.reduce(function (a, t) { return a + Math.max(0, t.linhas); }, 0);
          total += linhas;
          return '<div class="card"><b>' + b.icone + ' ' + esc(b.nome) + '</b>' +
            '<p class="muted small">' + b.idb + ' &middot; ' +
            (b.tamanho / 1024).toFixed(1) + ' KB</p>' +
            b.tabelas.map(function (t) {
              return '<div class="kv"><span>' + esc(t.nome) + '</span><b>' +
                     (t.linhas < 0 ? '?' : t.linhas) + '</b></div>';
            }).join('') +
            (b.fotos && b.fotos.length
              ? '<div class="kv"><span>fotos (fora do SQLite)</span><b>' + b.fotos.length + '</b></div>'
              : '') + '</div>';
        }).join('');
        box.innerHTML = html +
          '<p class="muted small">Total: ' + total + ' registro(s) em ' +
          inv.length + ' banco(s).</p>';
      }).catch(function (e) {
        box.innerHTML = '<p class="muted small warn">Falhou: ' + esc(e.message) + '</p>';
      });
    }

    function renderNuvem() {
      var c = (window.Nuvem && Nuvem.config()) || { url: '', key: '' };
      $(id + 'NuvUrl').textContent = revelado ? (c.url || '-') : (Nuvem.servidor() || '-');
      $(id + 'NuvKey').textContent = mascarar(c.key);
      $(id + 'NuvEstado').textContent = !Nuvem.ativa() ? 'não configurada'
        : (Nuvem.conectado() ? 'conectado' : 'configurada');
      $(id + 'NuvAp').textContent = Nuvem.aparelho();
      $(id + 'BtnRevelar').textContent = revelado ? '🙈 Esconder' : '👁 Revelar';

      var box = $(id + 'Users');
      var lista = (typeof COFRE !== 'undefined' && COFRE && COFRE.usuarios) || [];
      box.innerHTML = lista.length
        ? lista.map(function (u) {
            return '<div class="kv"><span>' + esc(u.nome || u.login) + '</span><b class="muted small">' +
                   esc(u.login) + '</b></div>';
          }).join('') + '<p class="muted small">' + lista.length +
            ' usuário(s) &middot; PBKDF2 ' + (COFRE.iter || '?') + ' rodadas</p>'
        : '<p class="muted small">Cofre vazio.</p>';
    }

    function renderPush() {
      if (!window.Push) return;
      $(id + 'VapidOk').textContent = Push.configurado() ? 'sim' : 'NÃO';
      Push.estado().then(function (t) { $(id + 'PushEstado').textContent = t; });
    }

    /* ---------- API da instância ---------- */
    return {
      cfg: cfg,
      preparar: function () {
        if (promessa) return promessa;
        promessa = Promise.resolve().then(function () {
          montarUI();
          renderInventario();
          renderNuvem();
          renderPush();
        });
        return promessa;
      },
      aoMostrarView: function (nome) {
        if (!montado) return;
        if (nome === id + '-nuvem') renderNuvem();
        else if (nome === id + '-push') renderPush();
      },
      fecharSheets: function () {}
    };
  }

  return {
    obter: function (cfg) {
      if (!instancia) instancia = criarInstancia(cfg);
      return instancia;
    },
    aoMostrarView: function (nome) {
      if (instancia) instancia.aoMostrarView(nome);
    }
  };
})();
