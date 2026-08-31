/* =========================================================
   Auth - login e cofre da configuracao da nuvem

   COMO FUNCIONA (importante entender antes de mexer):

   - Existe uma "chave-mestra" aleatoria (M), gerada uma unica vez.
   - A URL e a chave anon do Supabase ficam CIFRADAS com M (AES-GCM).
   - M nao e guardada em lugar nenhum em texto puro: para cada usuario
     guardamos M cifrada com a senha DELE (PBKDF2-SHA256 -> AES-GCM).

   Resultado: o arquivo js/usuarios.js publicado no GitHub e so ruido.
   Sem uma senha valida ninguem tira a chave do banco dali - nem o
   proprio app. Trocar a senha de um usuario nao mexe nos outros.

   Limite honesto: quem TEM uma senha valida consegue, com esforco,
   extrair a chave anon (o navegador precisa dela em claro para falar
   com o Supabase). A defesa real do banco continua sendo o RLS.
   ========================================================= */
var Auth = (function () {
  'use strict';

  var ITER_PADRAO = 310000;          // PBKDF2: ~0,3s num celular comum
  var CHAVE_SESSAO = 'sessao_almox';
  var sessao = null;                  // { login, nome, cfg:{url,key} }

  /* ---------- utilitarios binarios ---------- */
  function paraB64(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function deB64(s) {
    var bin = atob(s), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  function texto(s) { return new TextEncoder().encode(s); }
  function aleatorio(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  function disponivel() {
    return !!(window.crypto && window.crypto.subtle);
  }

  /* ---------- PBKDF2: senha -> chave AES ---------- */
  function derivar(senha, salt, iter) {
    return crypto.subtle
      .importKey('raw', texto(senha), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iter || ITER_PADRAO, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      });
  }

  /* ---------- AES-GCM ---------- */
  function cifrar(chave, dadosBytes) {
    var iv = aleatorio(12);
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, chave, dadosBytes)
      .then(function (ct) { return { iv: paraB64(iv), ct: paraB64(ct) }; });
  }
  function decifrar(chave, pacote) {
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: deB64(pacote.iv) }, chave, deB64(pacote.ct)
    );
  }

  function importarMestra(bytes) {
    return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /* ---------- cofre publicado (js/usuarios.js) ---------- */
  function cofre() {
    return (typeof COFRE !== 'undefined' && COFRE && COFRE.usuarios) ? COFRE : null;
  }
  function temCofre() {
    var c = cofre();
    return !!(c && c.usuarios.length && c.cfg);
  }
  function acharUsuario(login) {
    var c = cofre(); if (!c) return null;
    var alvo = String(login || '').trim().toLowerCase();
    for (var i = 0; i < c.usuarios.length; i++) {
      if (String(c.usuarios[i].login).toLowerCase() === alvo) return c.usuarios[i];
    }
    return null;
  }

  /* abre o envelope do usuario -> devolve a chave-mestra (CryptoKey) */
  function destrancar(login, senha) {
    var c = cofre();
    if (!c) return Promise.reject(new Error('Nenhum usuário cadastrado neste app.'));
    var u = acharUsuario(login);
    /* usuario inexistente: deriva mesmo assim, para nao entregar
       pelo tempo de resposta quais logins existem */
    var alvo = u || { salt: paraB64(aleatorio(16)), env: { iv: paraB64(aleatorio(12)), ct: paraB64(aleatorio(48)) } };

    return derivar(senha, deB64(alvo.salt), c.iter)
      .then(function (k) { return decifrar(k, alvo.env); })
      .then(function (mBytes) { return importarMestra(mBytes); })
      .then(function (M) { return { usuario: u, mestra: M }; })
      .catch(function () { throw new Error('Usuário ou senha inválidos.'); });
  }

  /* ---------- login ---------- */
  function entrar(login, senha, lembrar) {
    if (!disponivel()) {
      return Promise.reject(new Error('Este navegador não permite criptografia (abra o app por HTTPS).'));
    }
    return destrancar(login, senha).then(function (r) {
      return decifrar(r.mestra, cofre().cfg).then(function (buf) {
        var cfg = JSON.parse(new TextDecoder().decode(buf));
        sessao = { login: r.usuario.login, nome: r.usuario.nome || r.usuario.login, cfg: cfg };
        guardarSessao(lembrar);
        return sessao;
      });
    });
  }

  /* A sessao aberta guarda a config ja decifrada. Com "lembrar",
     fica no aparelho ate clicar em Sair; sem, morre ao fechar a aba. */
  function guardarSessao(lembrar) {
    var pacote = JSON.stringify(sessao);
    try {
      if (lembrar) localStorage.setItem(CHAVE_SESSAO, pacote);
      else sessionStorage.setItem(CHAVE_SESSAO, pacote);
    } catch (e) {}
  }

  function restaurar() {
    if (sessao) return sessao;
    var bruto = null;
    try { bruto = sessionStorage.getItem(CHAVE_SESSAO) || localStorage.getItem(CHAVE_SESSAO); } catch (e) {}
    if (!bruto) return null;
    try {
      var s = JSON.parse(bruto);
      if (s && s.login && s.cfg) sessao = s;
    } catch (e) { sessao = null; }
    return sessao;
  }

  function sair() {
    sessao = null;
    try {
      localStorage.removeItem(CHAVE_SESSAO);
      sessionStorage.removeItem(CHAVE_SESSAO);
    } catch (e) {}
  }

  function atual() { return sessao; }
  function usuario() { return sessao ? sessao.nome : ''; }
  function configNuvem() { return sessao ? sessao.cfg : null; }

  /* =========================================================
     ADMIN - usado so pela pagina admin.html (cadastro)
     ========================================================= */
  var admin = {
    ITER: ITER_PADRAO,

    /* cria um cofre do zero (primeira instalacao) */
    criar: function (url, key) {
      var mBytes = aleatorio(32);
      return importarMestra(mBytes).then(function (M) {
        return cifrar(M, texto(JSON.stringify({ url: url, key: key })))
          .then(function (pacote) {
            return {
              cofre: { v: 1, iter: ITER_PADRAO, cfg: pacote, usuarios: [] },
              mestra: M,
              mestraBytes: mBytes
            };
          });
      });
    },

    /* abre um cofre existente com login+senha (devolve a chave-mestra) */
    abrir: function (c, login, senha) {
      var alvo = null;
      var lg = String(login || '').trim().toLowerCase();
      for (var i = 0; i < c.usuarios.length; i++) {
        if (String(c.usuarios[i].login).toLowerCase() === lg) alvo = c.usuarios[i];
      }
      if (!alvo) return Promise.reject(new Error('Usuário ou senha inválidos.'));
      return derivar(senha, deB64(alvo.salt), c.iter)
        .then(function (k) { return decifrar(k, alvo.env); })
        .then(function (mBytes) {
          return importarMestra(mBytes).then(function (M) {
            return { mestra: M, mestraBytes: new Uint8Array(mBytes) };
          });
        })
        .catch(function () { throw new Error('Usuário ou senha inválidos.'); });
    },

    /* embrulha a chave-mestra com a senha do novo usuario */
    addUsuario: function (c, mestraBytes, dados) {
      var salt = aleatorio(16);
      return derivar(dados.senha, salt, c.iter).then(function (k) {
        return cifrar(k, mestraBytes).then(function (env) {
          var u = {
            login: String(dados.login).trim(),
            nome: String(dados.nome || dados.login).trim(),
            salt: paraB64(salt),
            env: env
          };
          /* troca de senha = substitui o envelope do mesmo login */
          var lg = u.login.toLowerCase(), trocou = false;
          for (var i = 0; i < c.usuarios.length; i++) {
            if (String(c.usuarios[i].login).toLowerCase() === lg) { c.usuarios[i] = u; trocou = true; }
          }
          if (!trocou) c.usuarios.push(u);
          return c;
        });
      });
    },

    removerUsuario: function (c, login) {
      var lg = String(login).toLowerCase();
      c.usuarios = c.usuarios.filter(function (u) { return String(u.login).toLowerCase() !== lg; });
      return c;
    },

    /* troca a URL/chave mantendo os usuarios */
    trocarNuvem: function (c, mestra, url, key) {
      return cifrar(mestra, texto(JSON.stringify({ url: url, key: key }))).then(function (p) {
        c.cfg = p;
        return c;
      });
    },

    /* gera o texto do arquivo js/usuarios.js */
    serializar: function (c) {
      return [
        '/* =========================================================',
        '   COFRE - gerado por admin.html. NAO edite na mao.',
        '',
        '   Contem a URL e a chave do Supabase CIFRADAS (AES-GCM) e,',
        '   para cada usuario, a chave-mestra embrulhada na senha dele',
        '   (PBKDF2-SHA256, ' + c.iter + ' rodadas). Sem senha valida,',
        '   este arquivo nao serve para nada.',
        '',
        '   Usuarios: ' + c.usuarios.map(function (u) { return u.login; }).join(', '),
        '   Gerado em: ' + new Date().toLocaleString('pt-BR'),
        '   ========================================================= */',
        'var COFRE = ' + JSON.stringify(c, null, 2) + ';',
        ''
      ].join('\n');
    }
  };

  return {
    disponivel: disponivel,
    temCofre: temCofre,
    entrar: entrar,
    restaurar: restaurar,
    sair: sair,
    atual: atual,
    usuario: usuario,
    configNuvem: configNuvem,
    admin: admin
  };
})();
