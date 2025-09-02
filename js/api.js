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
var RETRIES_PER_TARGET = 2;
var BACKOFF_MS = 400;
var HEADERS_PLAIN = { 'Content-Type': 'text/plain;charset=utf-8' };

// Known routes that Workers expose as path (per setup)
var PATH_ROUTES = {
  'create-order': '/create-order',
  'promo-validate': '/promo-validate',
  'quote': '/quote',
  'geocode': '/geocode',
  'reverse': '/reverse'
};

// ---------- helpers ----------
function nowTs() { return Date.now(); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function getBaseCandidates(baseString) {
  var raw = typeof baseString === 'string' ? baseString : '';
  if (!raw) return [];
  var parts = raw.split('|').join(',').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  // de-dup
  var seen = Object.create(null), out = [];
  for (var i=0;i<parts.length;i++){ var p=parts[i]; if(!seen[p]){seen[p]=1; out.push(p);} }
  return out;
}

function buildRouteUrls(base, route) {
  var urls = [];
  var b = base.replace(/\/+$/,'');
  var isWorker = /\.workers\.dev$/i.test(b) || /-workers\.dev$/i.test(b) || /workers\.dev\//i.test(base);
  var pathSuffix = PATH_ROUTES[route];

  if (isWorker && pathSuffix) urls.push(b + pathSuffix);
  urls.push(b + '?route=' + encodeURIComponent(route)); // always add query fallback
  return urls;
}

async function safeParseJSON(res) {
  try { return await res.json(); }
  catch (e) {
    var txt = '';
    try { txt = await res.text(); } catch (e2) { return {}; }
    if (!txt) return {};
    txt = txt.replace(/^\)\]\}',?\s*/, '');
    try { return JSON.parse(txt); }
    catch (e3) { return { ok:false, error:'parse_error', _raw: txt.slice(0, 2000) }; }
  }
}

async function fetchWithTimeout(url, body, signalExternal) {
  var ctrl = new AbortController();
  var timer = setTimeout(function(){ ctrl.abort(); }, TIMEOUT_MS);
  if (signalExternal) {
    if (signalExternal.aborted) ctrl.abort();
    else signalExternal.addEventListener('abort', function(){ ctrl.abort(); });
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

function shouldRetryResponse(res) {
  return res && res.status >= 500;
}

function attachAdminToken(payload, isAdmin){
  var p = payload == null ? {} : payload;
  if (isAdmin && ADMIN_TOKEN) {
    var merged = {};
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p,k)) merged[k]=p[k];
    merged.admin_token = ADMIN_TOKEN;
    p = merged;
  }
  if (p && typeof p === 'object' && p.__meta__ == null) {
    try { p.__meta__ = { t: nowTs() }; } catch(e){}
  }
  var body = '{}';
  try { body = JSON.stringify(p); } catch(e){}
  return body;
}

// ---------- core poster (parametris: baseString) ----------
async function corePost(baseString, route, payload, isAdmin){
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
          var res = await fetchWithTimeout(url, body);
          var json = await safeParseJSON(res);

          if (!res.ok && !json.ok && !json.error) {
            json = { ok:false, error:'http_' + res.status };
          }

          if (!json.ok && shouldRetryResponse(res) && attempt < RETRIES_PER_TARGET) {
            await sleep(BACKOFF_MS);
            continue;
          }
          return json;

        } catch(err) {
          if (attempt < RETRIES_PER_TARGET) {
            await sleep(BACKOFF_MS);
            continue;
          }
        }
      }
    }
  }

  return { ok:false, error:'network_timeout' };
}

// ---------- exported posters ----------
async function post(route, payload, isAdmin){           // Order/Midtrans
  return corePost(BASE, route, payload, !!isAdmin);
}
async function postShip(route, payload){                // Ongkir
  return corePost(SHIP_BASE, route, payload, false);
}

// ---------- convenience API maps ----------
var Api = {
  // Catalog / Menu
  cats:        function(){ return post('cat-list'); },
  menu:        function(){ return post('menu-list'); },
  menuSave:    function(payload){ return post('menu-save', payload, true); },
  menuDel:     function(id){ return post('menu-del', { id:id }, true); },

  // Uploads
  uploadImage: function(data_url, name){ return post('upload-image', { data_url:data_url, name:name }, true); },

  // Stock
  stockAdjust: function(payload){ return post('stock-adjust', payload, true); },

  // Promo
  promoList:     function(){ return post('promo-list', {}, true); },
  promoSave:     function(payload){ return post('promo-save', payload, true); },
  promoDel:      function(id){ return post('promo-del', { id:id }, true); },
  promoValidate: function(payload){ return post('promo-validate', payload); },

  // Checkout / Order
  createOrder:   function(payload){ return post('create-order', payload); }
};

// Ongkir: /quote (hitung ongkir), /geocode (autosuggest), /reverse (latlng → alamat)
var ApiShip = {
  quote:   function(payload){ return postShip('quote', payload); },
  geocode: function(payload){ return postShip('geocode', payload); },
  reverse: function(payload){ return postShip('reverse', payload); }
};

export { post, postShip, Api, ApiShip };
