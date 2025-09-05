'use strict';
/**
 * API tiny client (timeout + retry, no preflight, failover multi-BASE)
 * - post(route, payload, isAdmin)      -> BASE (Order/Midtrans)
 * - postShip(route, payload)           -> SHIP_BASE (Ongkir)
 * - Api:      wrapper route untuk Order/Menu/Promo/Stock
 * - ApiShip:  wrapper route untuk Ongkir (/quote, /geocode, /reverse)
 *
 * Catatan:
 * - Content-Type: text/plain;charset=utf-8 untuk hindari CORS preflight.
 * - Worker routes (path) yang dikenali:
 *     Order:   /create-order, /promo-validate
 *     Ongkir:  /quote, /geocode, /reverse
 */

import { BASE, SHIP_BASE, ADMIN_TOKEN } from './config.js';

// ---------- constants ----------
var TIMEOUT_MS = 9000;
var RETRIES_PER_TARGET = 2;            // retry per URL target
var BACKOFF_MS = 400;                  // base backoff
var JITTER_PCT = 0.35;                 // +/- jitter
var HEADERS_PLAIN = { 'Content-Type': 'text/plain;charset=utf-8' };

// Worker path yang didukung (selain itu akan pakai ?route= fallback)
var PATH_ROUTES = {
  'create-order':   '/create-order',
  'promo-validate': '/promo-validate',
  'quote':          '/quote',
  'geocode':        '/geocode',
  'reverse':        '/reverse'
};

// ---------- helpers ----------
function nowTs() { return Date.now(); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function backoff(attempt) {
  var base = BACKOFF_MS * Math.pow(2, attempt - 1);
  var jitter = base * JITTER_PCT;
  var delta = Math.floor(Math.random() * (jitter * 2 + 1) - jitter);
  var v = base + delta;
  return v < 0 ? 0 : v;
}

function getBaseCandidates(baseString) {
  var raw = typeof baseString === 'string' ? baseString : '';
  if (!raw) return [];
  var parts = raw
    .replace(/\s+/g, '') // buang spasi/enter yang tak perlu
    .split('|').join(',').split(',')
    .map(function (s) { return s.trim().replace(/\/+$/,''); })
    .filter(Boolean);
  var seen = Object.create(null), out = [];
  for (var i=0;i<parts.length;i++){
    var p = parts[i];
    if (!seen[p]) { seen[p] = 1; out.push(p); }
  }
  return out;
}
function isWorkerBase(b) {
  return /\.workers\.dev$/i.test(b) || /-workers\.dev$/i.test(b) || /workers\.dev\//i.test(b);
}
function buildRouteUrls(base, route) {
  var urls = [];
  var b = base.replace(/\/+$/,'');
  var pathSuffix = PATH_ROUTES[route];

  // Worker: coba path terlebih dahulu (tanpa ?route=)
  if (isWorkerBase(b) && pathSuffix) {
    urls.push(b + pathSuffix);
  }
  // Semua base: fallback query param ?route=
  urls.push(b + '?route=' + encodeURIComponent(route));
  return urls;
}

function stripBOM(s) {
  if (s && s.charCodeAt && s.charCodeAt(0) === 0xFEFF) {
    return s.slice(1);
  }
  return s;
}

async function safeParseJSON(res) {
  // Toleran: GAS kadang return text JSON dgn prefix )]}' atau BOM
  try {
    // Jika body kosong (204/No Content)
    if (res && (res.status === 204 || res.headers && res.headers.get && res.headers.get('Content-Length') === '0')) {
      return {};
    }
    return await res.json();
  } catch (e) {
    var txt = '';
    try { txt = await res.text(); } catch(e2) { return {}; }
    if (!txt) return {};
    txt = stripBOM(String(txt));
    txt = txt.replace(/^\)\]\}',?\s*/, ''); // hapus )]}' bila ada
    try { return JSON.parse(txt); }
    catch (e3) { return { ok:false, error:'parse_error', _raw: txt.slice(0, 2000) }; }
  }
}

async function fetchWithTimeout(url, body, signalExternal) {
  var ctrl = new AbortController();
  var timer = setTimeout(function(){ ctrl.abort(); }, TIMEOUT_MS);

  if (signalExternal) {
    if (signalExternal.aborted) ctrl.abort();
    else {
      try {
        signalExternal.addEventListener('abort', function(){ ctrl.abort(); });
      } catch (e) { /* abaikan */ }
    }
  }

  try {
    var res = await fetch(url, {
      method: 'POST',
      headers: HEADERS_PLAIN,
      body: body,
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
      keepalive: true
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function isRetryableStatus(res) {
  if (!res) return true;
  if (res.status >= 500) return true;        // 5xx
  if (res.status === 408) return true;       // Request Timeout
  if (res.status === 429) return true;       // Too Many Requests
  return false;
}
function isRetryableJson(json) {
  // Pola error transient khas Apps Script / backend
  if (!json || json.ok === true) return false;
  var msg = '';
  if (typeof json.error === 'string') msg = json.error;
  else if (typeof json.message === 'string') msg = json.message;
  else if (json._raw) msg = String(json._raw);
  msg = (msg || '').toLowerCase();

  // contoh pola yang sementara kita anggap retryable
  var transient = [
    'service invoked too many times',     // quota
    'the service is currently unavailable',
    'internal error',
    'maximum execution time',
    'execution time',
    'timeout',
    'timed out',
    'quota',
    'rate limit',
    'exceeded'
  ];
  for (var i=0;i<transient.length;i++){
    if (msg.indexOf(transient[i]) !== -1) return true;
  }
  return false;
}

function shouldRetry(res, json, attempt, maxAttempts) {
  if (attempt >= maxAttempts) return false;
  if (isRetryableStatus(res)) return true;
  if (isRetryableJson(json))  return true;
  return false;
}

function attachAdminToken(payload, isAdmin){
  var p = payload == null ? {} : payload;

  // clone sederhana agar tidak mutasi object luar
  var merged = {};
  if (p && typeof p === 'object') {
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p,k)) merged[k]=p[k];
  }
  if (isAdmin && ADMIN_TOKEN && merged.admin_token == null) {
    merged.admin_token = ADMIN_TOKEN;
  }
  if (merged && typeof merged === 'object' && merged.__meta__ == null) {
    try { merged.__meta__ = { t: nowTs() }; } catch(e){}
  }
  var body = '{}';
  try { body = JSON.stringify(merged); } catch(e){}
  return body;
}

// ---------- core poster (parametris: baseString) ----------
async function corePost(baseString, route, payload, isAdmin, externalSignal){
  var body = attachAdminToken(payload, !!isAdmin);
  var bases = getBaseCandidates(baseString);
  if (!bases.length) return { ok:false, error:'no_base_config' };

  for (var bi=0; bi<bases.length; bi++){
    var base = bases[bi];
    var urls = buildRouteUrls(base, route);

    for (var ui=0; ui<urls.length; ui++){
      var url = urls[ui];

      for (var attempt=1; attempt<=RETRIES_PER_TARGET; attempt++){
        try {
          var res  = await fetchWithTimeout(url, body, externalSignal);
          var json = await safeParseJSON(res);

          // Normalisasi error kalau bukan JSON ok:true
          if (!res.ok && (!json || json.ok !== true) && (!json || !json.error)) {
            json = { ok:false, error:'http_' + res.status };
          }

          // Retry untuk status/json transient
          if (shouldRetry(res, json, attempt, RETRIES_PER_TARGET)) {
            var wait = backoff(attempt);
            if (wait) { await sleep(wait); }
            continue;
          }

          // Sukses atau error non-retry → kembalikan
          return json;

        } catch(err) {
          // Network/timeout → retry
          if (attempt < RETRIES_PER_TARGET) {
            var wait2 = backoff(attempt);
            if (wait2) { await sleep(wait2); }
            continue;
          }
          // habis retry di url ini → coba url berikutnya / base berikutnya
        }
      }
      // next url
    }
    // next base
  }

  return { ok:false, error:'network_timeout' };
}

// ---------- exported posters ----------
async function post(route, payload, isAdmin, options){   // Order/Midtrans
  var signal = options && options.signal ? options.signal : null;
  return corePost(BASE, route, payload, !!isAdmin, signal);
}
async function postShip(route, payload, options){        // Ongkir
  var signal = options && options.signal ? options.signal : null;
  return corePost(SHIP_BASE, route, payload, false, signal);
}

// ---------- convenience API maps ----------
var Api = {
  // Catalog / Menu
  cats:        function(options){ return post('cat-list', null, false, options); },
  menu:        function(options){ return post('menu-list', null, false, options); },
  menuSave:    function(payload, options){ return post('menu-save', payload, true, options); },
  menuDel:     function(id, options){ return post('menu-del', { id:id }, true, options); },

  // Uploads
  uploadImage: function(data_url, name, options){ return post('upload-image', { data_url:data_url, name:name }, true, options); },

  // Stock
  stockAdjust: function(payload, options){ return post('stock-adjust', payload, true, options); },

  // Promo
  promoList:     function(options){ return post('promo-list', {}, true, options); },
  promoSave:     function(payload, options){ return post('promo-save', payload, true, options); },
  promoDel:      function(id, options){ return post('promo-del', { id:id }, true, options); },
  promoValidate: function(payload, options){ return post('promo-validate', payload, false, options); },

  // Checkout / Order
  createOrder:   function(payload, options){ return post('create-order', payload, false, options); }
};

// Ongkir: /quote (hitung ongkir), /geocode (autosuggest), /reverse (latlng → alamat)
var ApiShip = {
  quote:   function(payload, options){ return postShip('quote', payload, options); },
  geocode: function(payload, options){ return postShip('geocode', payload, options); },
  reverse: function(payload, options){ return postShip('reverse', payload, options); }
};

export { post, postShip, Api, ApiShip };
