/* ============================================================
   Service Worker — Controle PCP LION
   Estratégia:
     - Navegação (HTML): network-first com fallback para o cache
       (garante pegar a versão nova quando há internet, e abrir
        offline quando não há sinal no almoxarifado).
     - Demais estáticos: cache-first (rápido e 100% offline).
   Para publicar uma atualização: mudar CACHE_VERSION abaixo.
   ============================================================ */

var CACHE_VERSION = 'pcp-lion-v1.13.1';

var ARQUIVOS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './admin.html',
  './js/usuarios.js',
  './js/auth.js',
  './js/nuvem.js',
  './js/contagem.js',
  './js/eficiencia.js',
  './js/app.js',
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

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // HTML / navegação e o cofre de usuários -> network-first
  // (o cofre muda toda vez que um usuário é cadastrado; não pode
  //  ficar preso no cache até a próxima versão do app)
  var ehCofre = url.pathname.indexOf('/js/usuarios.js') > -1;
  var ehHtml = req.mode === 'navigate' ||
               (req.headers.get('accept') || '').indexOf('text/html') > -1;

  if (ehHtml || ehCofre) {
    /* 'no-store' fura o cache HTTP do navegador/CDN (o GitHub Pages
       serve com max-age, entao 'network-first' sozinho ainda entregava
       o cofre antigo por varios minutos depois de publicar). */
    e.respondWith(
      fetch(req.url, { cache: 'no-store', credentials: 'same-origin' }).then(function (resp) {
        var copia = resp.clone();
        caches.open(CACHE_VERSION).then(function (c) { c.put(req, copia); });
        return resp;
      }).catch(function () {
        return caches.match(req).then(function (r) {
          if (r) return r;
          return ehHtml ? caches.match('./index.html') : Response.error();
        });
      })
    );
    return;
  }

  // Estáticos -> cache-first
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
