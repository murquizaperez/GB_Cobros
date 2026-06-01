/* gas-bridge.js — Transporte HTTP hacia Apps Script.
 * ---------------------------------------------------
 * Reemplaza a google.script.run cuando el frontend se sirve desde Netlify.
 * Expone una función global  window.api(fn, ...args) -> Promise
 * con la MISMA firma que usabas antes, así no tocás el resto del código.
 *
 * Configurás la URL del Web App de GAS de cualquiera de estas formas:
 *   1) <script>window.GASTRO_GAS_URL = 'https://script.google.com/.../exec';</script>
 *      (recomendado: queda "horneada" en el HTML, ideal para el portal de clientes)
 *   2) localStorage.setItem('gastro_gas_url', 'https://.../exec')
 *      (override para admin/testing; tiene prioridad si existe)
 */
(function (global) {
  'use strict';

  var URL_KEY = 'gastro_gas_url';

  function getGasUrl() {
    return (localStorage.getItem(URL_KEY) || global.GASTRO_GAS_URL || '').trim();
  }
  function setGasUrl(u) {
    localStorage.setItem(URL_KEY, (u || '').trim());
    return getGasUrl();
  }

  // Heurística de ruteo: lecturas por JSONP (GET); el resto por POST.
  // Una escritura mal clasificada igual funciona (el server ejecuta la función),
  // pero los payloads grandes (carrito, pedido) DEBEN ir por POST -> por eso
  // crear*/registrar* nunca caen acá.
  function isRead(fn) {
    return /^(get|list|debug|diagnostic|verificar|buscar|obtener|consultar)/i.test(fn);
  }

  function unwrap(res) {
    if (res && typeof res === 'object') {
      if ('__error' in res) throw new Error(res.__error);
      if ('__data' in res) return res.__data;
    }
    return res;
  }

  function jsonp(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var cb = 'gascb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      var script = document.createElement('script');
      var done = false;
      var timer = setTimeout(function () { finish(new Error('Tiempo de espera agotado')); }, timeoutMs || 40000);

      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete global[cb]; } catch (e) { global[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
        if (err) reject(err); else resolve(data);
      }

      global[cb] = function (data) { finish(null, data); };
      script.onerror = function () { finish(new Error('Error de red (JSONP)')); };
      script.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + cb;
      document.head.appendChild(script);
    });
  }

  function api(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    var url = getGasUrl();
    if (!url) {
      return Promise.reject(new Error('No hay URL de Apps Script configurada (GASTRO_GAS_URL).'));
    }

    if (isRead(fn)) {
      var qs = url +
        (url.indexOf('?') === -1 ? '?' : '&') +
        'fn=' + encodeURIComponent(fn) +
        '&args=' + encodeURIComponent(JSON.stringify(args));
      return jsonp(qs).then(unwrap);
    }

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args }),
      redirect: 'follow'
    })
      .then(function (r) { return r.json(); })
      .then(unwrap);
  }

  // API pública
  global.api = api;
  global.GBBridge = { getGasUrl: getGasUrl, setGasUrl: setGasUrl, isRead: isRead, jsonp: jsonp };
})(window);
