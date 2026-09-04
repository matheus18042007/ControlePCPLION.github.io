/* =========================================================
   Push - inscrição do aparelho para notificações

   Usado só pelo módulo Faltas VG. O envio mora na Edge Function
   (supabase/functions/faltas-notificar); aqui só pedimos
   permissão, criamos a subscription e mandamos para o Supabase.

   A chave abaixo é a VAPID *pública* - ela é pública por
   definição (vai no ar em toda requisição de push), então não
   precisa entrar no cofre cifrado do js/usuarios.js.

   Para gerar o par de chaves:
       npx web-push generate-vapid-keys
   A pública entra aqui; a privada vira secret da Edge Function.
   ========================================================= */
var Push = (function () {
  'use strict';

  var VAPID_PUBLIC = 'BEOguUNOTtGllNm_dIm3chDwa_8oKUQcVk3l7UahegBiy1NjhYjAQ2yFxA2lokrfDu4MGMwmBXP_T7EGAkW2H44';

  function configurado() {
    return VAPID_PUBLIC && VAPID_PUBLIC.indexOf('COLE_AQUI') !== 0;
  }

  function suportado() {
    return !!(window.Notification && navigator.serviceWorker && window.PushManager);
  }

  /* base64url -> Uint8Array (formato que o PushManager exige) */
  function chaveBinaria(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function inscricaoAtual() {
    if (!suportado()) return Promise.resolve(null);
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).catch(function () { return null; });
  }

  /* texto curto para mostrar na tela de configurações */
  function estado() {
    if (!suportado()) return Promise.resolve('Não suportado neste navegador');
    if (!configurado()) return Promise.resolve('Chave VAPID não configurada');
    if (Notification.permission === 'denied') {
      return Promise.resolve('Bloqueado nas permissões do navegador');
    }
    return inscricaoAtual().then(function (sub) {
      return sub ? 'Ativado' : 'Desativado';
    });
  }

  function ativar() {
    if (!suportado()) return Promise.reject(new Error('Este navegador não suporta notificações'));
    if (!configurado()) return Promise.reject(new Error('Chave VAPID não configurada no js/push.js'));

    return Notification.requestPermission().then(function (p) {
      if (p !== 'granted') throw new Error('Permissão negada. Libere nas configurações do navegador.');
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub) return sub;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: chaveBinaria(VAPID_PUBLIC)
        });
      });
    }).then(function (sub) {
      if (!(window.Nuvem && Nuvem.ativa())) {
        throw new Error('Faça login no cofre antes de ativar as notificações');
      }
      var usuario = (window.PCP && PCP.operador && PCP.operador()) || null;
      return Nuvem.push.registrar(sub, usuario).then(function () {
        return 'Notificações ativadas neste aparelho';
      });
    });
  }

  function desativar() {
    return inscricaoAtual().then(function (sub) {
      if (!sub) return true;
      var endpoint = sub.endpoint;
      return sub.unsubscribe().then(function () {
        if (window.Nuvem && Nuvem.ativa()) {
          return Nuvem.push.remover(endpoint).catch(function () { return true; });
        }
        return true;
      });
    });
  }

  return {
    suportado: suportado,
    configurado: configurado,
    estado: estado,
    ativar: ativar,
    desativar: desativar
  };
})();
