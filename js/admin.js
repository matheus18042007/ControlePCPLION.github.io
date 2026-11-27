(function () {
'use strict';

function $(id) { return document.getElementById(id); }
var tmr = null;
function toast(msg, kind) {
  var t = $('toast');
  t.className = 'toast show ' + (kind || '');
  t.textContent = msg;
  clearTimeout(tmr);
  tmr = setTimeout(function () { t.className = 'toast'; }, 3000);
}
function mostrar(id, sim) { $(id).classList.toggle('oculto', !sim); }

var MODS = window.MODULOS || [];

var cofre = null;         // objeto em edicao
var mestraBytes = null;   // chave-mestra aberta (Uint8Array)
var mestra = null;        // CryptoKey

var existente = (typeof COFRE !== 'undefined' && COFRE && COFRE.usuarios && COFRE.usuarios.length);

if (!window.crypto || !window.crypto.subtle) {
  document.querySelector('.wrap').innerHTML =
    '<div class="card"><h3>Navegador sem suporte</h3><p class="muted">' +
    'Abra esta página por <b>http://localhost</b> ou <b>https://</b> ' +
    '(a criptografia do navegador não funciona em arquivo solto <code>file://</code>).</p></div>';
  return;
}

if (existente) {
  $('tituloAbrir').textContent = 'Destrancar o cofre';
  $('ajudaAbrir').textContent = 'Entre com um usuário já cadastrado para poder incluir outros.';
  mostrar('boxAbrir', true);
} else {
  $('tituloAbrir').textContent = 'Criar o cofre (primeira vez)';
  $('ajudaAbrir').textContent = 'Ainda não há usuários. Informe os dados do Supabase e crie o primeiro acesso.';
  mostrar('boxCriar', true);
}

function abriuCofre() {
  mostrar('secAbrir', false);
  mostrar('secUsuarios', true);
  mostrar('secNuvem', true);
  mostrar('secGerar', true);
  pintarModsNovo();
  pintarUsuarios();
  gerar();
}

/* Modulos com permissao de edicao (Auth.MODULOS_COM_EDICAO) ganham a caixa
   "Editar" ao lado de "Ver". Desmarcar Ver desmarca Editar; marcar Editar marca Ver.
   data-k: 'ver' | 'ed'. Escopo: o container .mods mais proximo. */
function comEdicao(id) { return Auth.MODULOS_COM_EDICAO.indexOf(id) !== -1; }

function caixaEditar(m, attrs, marcado) {
  return comEdicao(m.id)
    ? '<label><input type="checkbox" data-k="ed" ' + attrs + ' value="' + m.id + '"' + (marcado ? ' checked' : '') + '> Editar</label>'
    : '';
}

function sincVerEdita(c) {
  var raiz = c.closest('.mods'), ver = c.dataset.k === 'ver';
  var outro = raiz.querySelector('[data-k="' + (ver ? 'ed' : 'ver') + '"][value="' + c.value + '"]');
  if (!outro) return;
  if (ver && !c.checked) outro.checked = false;
  if (!ver && c.checked) outro.checked = true;
}

function marcados(raiz, k) {
  var sel = [];
  Array.prototype.forEach.call(raiz.querySelectorAll('[data-k="' + k + '"]'), function (o) {
    if (o.checked) sel.push(o.value);
  });
  return sel;
}

function pintarModsNovo() {
  var raiz = $('modsNovo');
  raiz.innerHTML = MODS.map(function (m) {
    return '<label><input type="checkbox" data-k="ver" value="' + m.id + '" checked> ' + m.nome + '</label>' +
           caixaEditar(m, '', false);
  }).join('');
  Array.prototype.forEach.call(raiz.querySelectorAll('[data-k]'), function (c) {
    c.addEventListener('change', function () { sincVerEdita(c); });
  });
}

function modsNovoSelecionados() { return marcados($('modsNovo'), 'ver'); }
function editaNovoSelecionados() { return marcados($('modsNovo'), 'ed'); }

function pintarUsuarios() {
  var box = $('listaUsuarios');
  if (!cofre.usuarios.length) {
    box.innerHTML = '<div class="vazio">Nenhum usuário.</div>';
    return;
  }
  box.innerHTML = cofre.usuarios.map(function (u) {
    var mods = u.mods || MODS.map(function (m) { return m.id; });
    var edita = u.edita || [];
    return '<div class="u"><div class="grow"><b>' + u.login + '</b><br>' +
           '<small>' + (u.nome || '') + '</small></div>' +
           '<button class="x" data-rm="' + u.login + '" type="button">Remover</button>' +
           '<div class="mods">' + MODS.map(function (m) {
             var ed = edita.indexOf(m.id) !== -1;
             return '<label><input type="checkbox" data-k="ver" data-user="' + u.login + '" value="' + m.id + '"' +
                    (ed || mods.indexOf(m.id) !== -1 ? ' checked' : '') + '> ' + m.nome + '</label>' +
                    caixaEditar(m, 'data-user="' + u.login + '"', ed);
           }).join('') + '</div></div>';
  }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('[data-user]'), function (c) {
    c.addEventListener('change', function () {
      var lg = c.dataset.user, raiz = c.closest('.mods');
      sincVerEdita(c);
      Auth.admin.setMods(cofre, lg, marcados(raiz, 'ver'), marcados(raiz, 'ed'));
      gerar();
      toast('Permissões de ' + lg + ' atualizadas.', 'ok');
    });
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-rm]'), function (b) {
    b.addEventListener('click', function () {
      if (cofre.usuarios.length <= 1) { toast('Precisa sobrar pelo menos um usuário.', 'err'); return; }
      if (!confirm('Remover ' + b.dataset.rm + '? Ele perde o acesso no próximo update do app.')) return;
      Auth.admin.removerUsuario(cofre, b.dataset.rm);
      pintarUsuarios(); gerar();
    });
  });
}

/* ---------- criar ---------- */
$('btnCriar').addEventListener('click', function () {
  var url = $('novoUrl').value.trim().replace(/\/+$/, '');
  var key = $('novoKey').value.trim();
  var lg = $('admLogin').value.trim();
  var nm = $('admNome').value.trim() || lg;
  var sn = $('admSenha').value;

  if (!/^https?:\/\/.+/.test(url)) { toast('URL inválida (precisa começar com https://).', 'err'); return; }
  if (key.length < 20) { toast('Chave anon parece curta demais.', 'err'); return; }
  if (!lg) { toast('Informe o login.', 'err'); return; }
  if (sn.length < 6) { toast('Senha muito curta (mínimo 6).', 'err'); return; }

  this.disabled = true; this.textContent = 'Criando...';
  var btn = this;
  Auth.admin.criar(url, key)
    .then(function (r) {
      cofre = r.cofre; mestra = r.mestra; mestraBytes = r.mestraBytes;
      return Auth.admin.addUsuario(cofre, mestraBytes, { login: lg, nome: nm, senha: sn });
    })
    .then(function () {
      $('cfgUrl').value = url; $('cfgKey').value = key;
      toast('Cofre criado.', 'ok');
      abriuCofre();
    })
    .catch(function (e) { toast('Erro: ' + e.message, 'err'); })
    .then(function () { btn.disabled = false; btn.textContent = 'Criar cofre'; });
});

/* ---------- abrir ---------- */
$('btnAbrir').addEventListener('click', function () {
  var btn = this;
  btn.disabled = true; btn.textContent = 'Destrancando...';
  cofre = JSON.parse(JSON.stringify(COFRE));
  Auth.admin.abrir(cofre, $('abrLogin').value, $('abrSenha').value)
    .then(function (r) {
      mestra = r.mestra; mestraBytes = r.mestraBytes;
      /* mostra a config atual em claro para conferencia */
      return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Uint8Array.from(atob(cofre.cfg.iv), function (c) { return c.charCodeAt(0); }) },
        mestra,
        Uint8Array.from(atob(cofre.cfg.ct), function (c) { return c.charCodeAt(0); })
      );
    })
    .then(function (buf) {
      var c = JSON.parse(new TextDecoder().decode(buf));
      $('cfgUrl').value = c.url; $('cfgKey').value = c.key;
      toast('Cofre aberto.', 'ok');
      abriuCofre();
    })
    .catch(function (e) { toast(e.message, 'err'); })
    .then(function () { btn.disabled = false; btn.textContent = 'Destrancar'; });
});

/* ---------- adicionar usuario ---------- */
$('btnAddUser').addEventListener('click', function () {
  var lg = $('uLogin').value.trim();
  var nm = $('uNome').value.trim() || lg;
  var sn = $('uSenha').value;
  if (!lg) { toast('Informe o login.', 'err'); return; }
  if (sn.length < 6) { toast('Senha muito curta (mínimo 6).', 'err'); return; }

  var btn = this;
  btn.disabled = true; btn.textContent = 'Salvando...';
  Auth.admin.addUsuario(cofre, mestraBytes, { login: lg, nome: nm, senha: sn, mods: modsNovoSelecionados(), edita: editaNovoSelecionados() })
    .then(function () {
      $('uLogin').value = ''; $('uNome').value = ''; $('uSenha').value = '';
      pintarModsNovo();
      pintarUsuarios(); gerar();
      toast('Usuário salvo: ' + lg, 'ok');
    })
    .catch(function (e) { toast('Erro: ' + e.message, 'err'); })
    .then(function () { btn.disabled = false; btn.textContent = 'Salvar usuário'; });
});

/* ---------- trocar nuvem ---------- */
$('btnTrocarNuvem').addEventListener('click', function () {
  var url = $('cfgUrl').value.trim().replace(/\/+$/, '');
  var key = $('cfgKey').value.trim();
  if (!/^https?:\/\/.+/.test(url) || key.length < 20) { toast('URL ou chave inválida.', 'err'); return; }
  Auth.admin.trocarNuvem(cofre, mestra, url, key).then(function () {
    gerar(); toast('Dados da nuvem atualizados.', 'ok');
  });
});

/* ---------- gerar arquivo ---------- */
var conteudo = '';
function gerar() {
  conteudo = Auth.admin.serializar(cofre);
  /* mostra o arquivo INTEIRO: cortar aqui fazia quem copiava a mao
     levar um cofre truncado (a partir do 2o usuario ja passava). */
  $('previa').textContent = conteudo;
}

/* Salvar por cima: no Chrome/Edge do PC (File System Access API) o admin
   escolhe js/usuarios.js uma vez; o "handle" fica no IndexedDB e os proximos
   cliques gravam direto nele. Sem a API (Firefox, Safari, celular) cai no
   download comum. */
var PODE_GRAVAR = typeof window.showSaveFilePicker === 'function';
var arqHandle = null;

function idbHandle(modo, valor) {
  return new Promise(function (ok, falha) {
    var req = indexedDB.open('pcp-admin', 1);
    req.onupgradeneeded = function () { req.result.createObjectStore('arquivos'); };
    req.onerror = function () { falha(req.error); };
    req.onsuccess = function () {
      var tx = req.result.transaction('arquivos', modo);
      var st = tx.objectStore('arquivos');
      var r = modo === 'readonly' ? st.get('usuarios')
            : valor ? st.put(valor, 'usuarios') : st.delete('usuarios');
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { falha(r.error); };
    };
  });
}

function pintarDestino() {
  $('arqDestino').textContent = !PODE_GRAVAR
    ? 'Este navegador só baixa o arquivo: coloque-o em js/usuarios.js na mão.'
    : arqHandle ? 'Grava direto em: ' + arqHandle.name + ' (o que você escolheu antes).'
    : 'No 1º clique, escolha o arquivo js/usuarios.js da pasta do app.';
  $('btnTrocarArq').classList.toggle('oculto', !arqHandle);
}

if (PODE_GRAVAR) {
  idbHandle('readonly').then(function (h) { arqHandle = h || null; pintarDestino(); })
    .catch(function () { pintarDestino(); });
}
pintarDestino();

function baixarComum() {
  var blob = new Blob([conteudo], { type: 'text/javascript' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'usuarios.js';
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast('Baixado. Coloque em js/usuarios.js e publique.', 'ok');
}

function escolherArquivo() {
  return window.showSaveFilePicker({
    suggestedName: 'usuarios.js',
    types: [{ description: 'JavaScript', accept: { 'text/javascript': ['.js'] } }]
  }).then(function (h) {
    arqHandle = h;
    return idbHandle('readwrite', h).catch(function () {}).then(function () { return h; });
  });
}

function gravar(h) {
  return h.requestPermission({ mode: 'readwrite' }).then(function (p) {
    if (p !== 'granted') throw new Error('Permissão negada para gravar no arquivo.');
    return h.createWritable();
  }).then(function (w) {
    return w.write(conteudo).then(function () { return w.close(); });
  });
}

function salvar(trocar) {
  if (!PODE_GRAVAR) { baixarComum(); return; }
  var p = (!trocar && arqHandle) ? Promise.resolve(arqHandle) : escolherArquivo();
  p.then(gravar).then(function () {
    pintarDestino();
    toast('Salvo em ' + arqHandle.name + '. Agora é só publicar.', 'ok');
  }).catch(function (e) {
    if (e && e.name === 'AbortError') return; /* fechou o seletor */
    if (e && e.name === 'NotFoundError') {    /* arquivo movido/apagado */
      arqHandle = null; idbHandle('readwrite', null).catch(function () {}); pintarDestino();
      toast('Não achei mais o arquivo. Clique de novo e escolha js/usuarios.js.', 'err');
      return;
    }
    toast('Erro ao salvar: ' + (e && e.message || e), 'err');
  });
}

$('btnBaixar').addEventListener('click', function () { salvar(false); });
$('btnTrocarArq').addEventListener('click', function () { salvar(true); });

$('btnCopiar').addEventListener('click', function () {
  navigator.clipboard.writeText(conteudo)
    .then(function () { toast('Copiado.', 'ok'); })
    .catch(function () { toast('Não consegui copiar - use o botão Salvar.', 'err'); });
});

})();
