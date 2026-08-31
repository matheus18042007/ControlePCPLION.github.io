/* ============================================================
   Service Worker — Almoxarifado PBA
   Estratégia:
     - Navegação (HTML): network-first com fallback para o cache
       (garante pegar a versão nova quando há internet, e abrir
        offline quando não há sinal no almoxarifado).
     - Demais estáticos: cache-first (rápido e 100% offline).
   Para publicar uma atualização: mudar CACHE_VERSION abaixo.
   ============================================================ */

var CACHE_VERSION = 'almox-pba-v1.4.0';

var ARQUIVOS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/config.js',
  './js/nuvem.js',
  './js/app.js',
  './vendor/sql-wasm.js',
  './vendor/sql-wasm.wasm',
  './vendor/html5-qrcode.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
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

  // HTML / navegação -> network-first
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') > -1) {
    e.respondWith(
      fetch(req).then(function (resp) {
        var copia = resp.clone();
        caches.open(CACHE_VERSION).then(function (c) { c.put(req, copia); });
        return resp;
      }).catch(function () {
        return caches.match(req).then(function (r) { return r || caches.match('./index.html'); });
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
