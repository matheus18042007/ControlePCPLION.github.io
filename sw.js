/* ============================================================
   Service Worker — Controle PCP LION
   Estratégia:
     - Navegação (HTML): network-first com fallback para o cache
       (garante pegar a versão nova quando há internet, e abrir
        offline quando não há sinal no almoxarifado).
     - Demais estáticos: cache-first (rápido e 100% offline).
   Para publicar uma atualização: mudar CACHE_VERSION abaixo.
   ============================================================ */

var CACHE_VERSION = 'pcp-lion-v3.7';

var ARQUIVOS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './admin.html',
  './js/base.js',
  './js/modulos.js',
  './js/usuarios.js',
  './js/auth.js',
  './js/nuvem.js',
  './js/contagem.js',
  './js/eficiencia.js',
  './js/push.js',
  './js/faltas.js',
  './js/kits.js',
  './js/fluxo.js',
  './js/banco.js',
  './js/app.js',
  './js/admin.js',
  './vendor/sql-wasm.js',
  './vendor/sql-wasm.wasm',
  './vendor/html5-qrcode.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './favicon.ico'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(function (c) {
      return Promise.all(ARQUIVOS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () { /* ignora falha isolada */ });
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.map(function (n) {
        if (n !== CACHE_VERSION) return caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ---------- notificacoes (so o modulo Faltas VG usa) ---------- */

self.addEventListener('push', function (e) {
  var dados = { titulo: 'Faltas VG', corpo: 'Novas faltas registradas.' };
  if (e.data) {
    try { dados = e.data.json(); } catch (err) { dados.corpo = e.data.text(); }
  }
  e.waitUntil(
    self.registration.showNotification(dados.titulo || 'Faltas VG', {
      body: dados.corpo || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      /* Faltas não manda tag/url e segue igual; o Fluxo manda
         tag própria para não substituir a notificação das Faltas */
      tag: dados.tag || 'faltas-vg',
      renotify: true,
      data: { url: dados.url || './#faltas' }
    })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        if ('focus' in lista[i]) return lista[i].focus();
      }
      var url = (e.notification.data && e.notification.data.url) || './#faltas';
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

/* Busca na rede; se a rede falhar, ou demorar mais de 4 s com sinal
   fraco, entrega o cache. A resposta da rede só vai para o cache se
   vier OK (não guarda página de erro 404 no lugar do arquivo). */
function redeComFallback(url, chave, modoCache, ehHtml) {
  return new Promise(function (resolve) {
    var entregue = false;
    var entregar = function (r) { if (!entregue && r) { entregue = true; resolve(r); } };
    var doCache = function () {
      return caches.match(chave, { ignoreSearch: true }).then(function (r) {
        if (r || !ehHtml) return r;
        return caches.match('./index.html');
      });
    };
    var timer = setTimeout(function () { doCache().then(entregar); }, 4000);

    fetch(url, { cache: modoCache, credentials: 'same-origin' }).then(function (resp) {
      clearTimeout(timer);
      if (resp.ok) {
        var copia = resp.clone();
        caches.open(CACHE_VERSION).then(function (c) { return c.put(chave, copia); }).catch(function (e) { console.warn('[sw] cache nao gravado: ' + chave, e); });
      }
      entregar(resp);
    }).catch(function () {
      clearTimeout(timer);
      doCache().then(function (r) { entregar(r || Response.error()); });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // HTML, cofre de usuários e código do app (js/css) -> network-first.
  // O cofre muda toda vez que um usuário é cadastrado, e o código muda
  // a cada publicação: com sinal, sempre vem o arquivo novo, mesmo se
  // esquecer de mudar o CACHE_VERSION. Sem sinal, abre pelo cache.
  var ehCofre = url.pathname.indexOf('/js/usuarios.js') > -1;
  var ehHtml = req.mode === 'navigate' ||
               (req.headers.get('accept') || '').indexOf('text/html') > -1;
  var ehCodigo = url.pathname.indexOf('/vendor/') === -1 &&
                 /\.(js|css|html|json)$/.test(url.pathname);

  if (ehHtml || ehCofre || ehCodigo) {
    /* 'no-store' fura o cache HTTP do navegador/CDN no HTML e no cofre;
       o resto revalida ('no-cache': 304 quando nada mudou, bem leve).
       O cofre é guardado sempre na mesma chave (o login pede ele com
       ?v=... para furar o cache, sem encher o cache de cópias). */
    var chave = ehCofre ? './js/usuarios.js' : req;
    e.respondWith(redeComFallback(req.url, chave,
      (ehHtml || ehCofre) ? 'no-store' : 'no-cache', ehHtml));
    return;
  }

  // Bibliotecas (vendor/) e ícones -> cache-first
  e.respondWith(
    caches.match(req).then(function (cacheado) {
      if (cacheado) return cacheado;
      return fetch(req).then(function (resp) {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          var copia = resp.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copia); });
        }
        return resp;
      });
    })
  );
});
