/* =========================================================
   BASE - o que todo módulo repetia

   Antes: idbOpen/idbSet/idbGet/lerCsv/num/semAcento e o par
   abrirBanco/salvar/sel/um/escalar viviam copiados dentro de
   app.js, contagem.js, eficiencia.js e faltas.js. Quatro
   cópias da mesma coisa: um bug de fuso, de CSV ou de save
   tinha que ser corrigido quatro vezes.

   Agora mora aqui. Cada módulo continua com o SEU banco
   (um arquivo .db por módulo, no IndexedDB próprio) - isso
   é de propósito e não mudou. O que ficou compartilhado é
   só o encanamento.

   Carrega ANTES de todos os outros js.
========================================================= */
window.PCPDB = (function () {
  'use strict';

  /* ---------- IndexedDB (guarda o .db em bytes) ---------- */
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

  /* ---------- texto ---------- */
  function semAcento(s) {
    s = String(s == null ? '' : s);
    return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
  }

  /* id de registro: precisa ser único entre aparelhos offline */
  function novoId(prefixo) {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return (prefixo || 'R') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* número: aceita 1.5 (input number) e 1,5 (digitado a mão).
     Só trata o ponto como separador de milhar quando existe
     uma vírgula decimal na frente - senão 1.5 viraria 15. */
  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    var s = String(v).replace(/\s/g, '');
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  /* ---------- CSV bem simples (separador ; ou ,) ---------- */
  function lerCsv(texto) {
    var t = String(texto).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
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
    /* cabeçalho sem acento e minúsculo: aceita "descrição", "código" */
    var cab = parse(linhas[0]).map(function (h) { return semAcento(h).toLowerCase(); });
    return { cabecalho: cab, linhas: linhas.slice(1).map(parse) };
  }

  /* =========================================================
     kit: o banco SQLite de UM módulo

       var K = PCPDB.kit({ idb: 'pcp_faltas', id: 'faltas',
                           schema: SCHEMA, aoSalvar: fn });
       K.abrir().then(...)   -> K.db pronto
       K.sel / K.um / K.escalar / K.salvar(imediato)

     cfg.id define a chave 'ultimo_salvamento_<id>'; sem id
     usa 'ultimo_salvamento' (almoxarifado, o módulo raiz).
  ========================================================= */
  function kit(cfg) {
    var k = { db: null };
    var saveTimer = null;
    var chaveSalvo = 'ultimo_salvamento' + (cfg.id ? '_' + cfg.id : '');

    k.abrir = function () {
      return initSqlJs({ locateFile: function (f) { return './vendor/' + f; } })
        .then(function (SQL) {
          k.SQL = SQL;
          return idbGet(cfg.idb, 'dbfile').then(function (bytes) {
            if (bytes && bytes.byteLength) {
              try { k.db = new SQL.Database(new Uint8Array(bytes)); }
              catch (e) { k.db = new SQL.Database(); }
            } else {
              k.db = new SQL.Database();
            }
            if (cfg.schema) k.db.run(cfg.schema);
            return k.db;
          });
        });
    };

    k.salvar = function (imediato) {
      if (!k.db) return;
      clearTimeout(saveTimer);
      var grava = function () {
        try {
          idbSet(cfg.idb, 'dbfile', k.db.export()).then(function () {
            try { localStorage.setItem(chaveSalvo, window.PCP.agoraISO()); } catch (e) {}
            if (cfg.aoSalvar) cfg.aoSalvar();
          });
        } catch (e) {
          if (window.PCP && PCP.toast) PCP.toast('Erro ao salvar: ' + e.message, 'err');
        }
      };
      if (imediato) grava(); else saveTimer = setTimeout(grava, 400);
    };

    k.sel = function (sql, params) {
      var out = [], st = k.db.prepare(sql);
      if (params) st.bind(params);
      while (st.step()) out.push(st.getAsObject());
      st.free();
      return out;
    };
    k.um = function (sql, params) { var r = k.sel(sql, params); return r[0] || null; };
    k.escalar = function (sql, params) {
      var r = k.um(sql, params);
      if (!r) return 0;
      return r[Object.keys(r)[0]];
    };

    return k;
  }

  return {
    open: idbOpen, set: idbSet, get: idbGet,
    semAcento: semAcento, novoId: novoId, num: num, lerCsv: lerCsv,
    kit: kit
  };
})();
