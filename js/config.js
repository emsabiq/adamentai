'use strict';
/**
 * Konfigurasi runtime (override-able via window.CONFIG)
 *
 * Export:
 *  - BASE (Order/Midtrans), SHIP_BASE (Ongkir), ADMIN_PIN, ADMIN_TOKEN, CF_IMAGE_PROXY
 *  - BEST_CATEGORY, STRIP_CATEGORY
 *  - MENU_CACHE_KEY, MENU_CACHE_TTL
 *
 * Catatan:
 * - BASE & SHIP_BASE mendukung multi-endpoint (failover) dengan pemisah "|" atau ",".
 * - Override via window.CONFIG, contoh:
 *   window.CONFIG = {
 *     BASE: "https://script.google.com/macros/s/....../exec|https://midtrans-proxy...workers.dev",
 *     SHIP_BASE: "https://adamentai-ongkir-proxy...workers.dev|https://script.google.com/macros/s/....../exec",
 *     // alias yang juga diterima:
 *     BASE_ONGKIR: "...", ONGKIR_BASE: "...",
 *     ADMIN_PIN: "4321", ADMIN_TOKEN: "secret", CF_IMAGE_PROXY: "https://img.example.com"
 *   }
 *
 * Prinsip agar order TERCATAT ke Sheet:
 * - Pastikan GAS Orders berada di POSISI PERTAMA pada BASE (sudah di-set default).
 *   Worker akan tetap meneruskan ke GAS, namun urutan ini memberi jalur langsung.
 */

// ===== Default (boleh di-override via window.CONFIG) =====

// Order/Midtrans (GAS → fallback Worker) — GAS diletakkan di depan agar langsung tulis ke Sheet.
var BASE =
  'https://script.google.com/macros/s/AKfycbzKtWlxd_I4x-o7gnPy7spjSoMxDZm01VtrRlHPD5yd3tvKq6X3t19ZM4-qUVT6dF8K/exec' +
  '|' +
  'https://midtrans-proxy.msabiq-stan.workers.dev';

// Ongkir (Worker → fallback GAS Ongkir) — urutan ini OK (Worker lebih ringan/cepat, tetap kompatibel).
var SHIP_BASE =
  'https://adamentai-ongkir-proxy.msabiq-stan.workers.dev' +
  '|' +
  'https://script.google.com/macros/s/AKfycbyTeheUEt75izR3zxlhNJ84ce0P0dBdaXvtQ_YtlzjrLnCM7Ib1AuqOFs0Ys0uBx9s/exec';

var ADMIN_PIN      = '1234';
var ADMIN_TOKEN    = '';
var CF_IMAGE_PROXY = '';

// Kategori khusus untuk layout opsional
var BEST_CATEGORY  = 'Best Seller';
var STRIP_CATEGORY = 'Paket & Promo';

// Cache menu FE
var MENU_CACHE_KEY = 'adm_menu_cache_v6';
var MENU_CACHE_TTL = 60000; // 60 detik (ES2019-safe)

// ===== Helpers =====
function isArray(x){ return Object.prototype.toString.call(x) === '[object Array]'; }
function isString(x){ return typeof x === 'string'; }
function trimStr(s){ return String(s == null ? '' : s).trim(); }

// Validasi sangat ringan (http/https + domain), tidak memaksa strict.
function looksLikeUrl(u){
  if (!u) return false;
  var s = String(u);
  if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0) return true;
  return false;
}

// Gabungkan BASE menjadi string pipe ("a|b|c"), dedupe, dan trim trailing slash
function normalizeBase(input){
  var arr = [];
  if (isArray(input)) {
    for (var i=0;i<input.length;i++){
      var v = trimStr(input[i]);
      if (v) arr.push(v);
    }
  } else if (isString(input)) {
    var s = trimStr(input);
    if (s) {
      // dukung pemisah '|' atau ','
      var tokens = s.split('|').join(',').split(',');
      for (var j=0;j<tokens.length;j++){
        var t = trimStr(tokens[j]);
        if (t) arr.push(t);
      }
    }
  } else {
    return '';
  }

  // bersihkan trailing slash dan buang yang tidak tampak seperti URL
  var cleaned = [];
  for (var k=0;k<arr.length;k++){
    var u = arr[k].replace(/\/+$/,'');
    if (looksLikeUrl(u)) cleaned.push(u);
  }

  // dedupe dengan mempertahankan urutan pertama kali muncul
  var seen = Object.create(null);
  var out = [];
  for (var m=0;m<cleaned.length;m++){
    var p = cleaned[m];
    if (!seen[p]) { seen[p] = 1; out.push(p); }
  }
  return out.join('|');
}

// Pastikan jika terdapat GAS Orders & Worker di BASE, GAS tetap di depan
function ensureGasFirstForOrders(baseStr){
  var s = trimStr(baseStr);
  if (!s) return s;
  var parts = s.split('|');
  if (parts.length <= 1) return s;

  var gas = [];
  var others = [];
  for (var i=0;i<parts.length;i++){
    var p = trimStr(parts[i]);
    if (!p) continue;
    // deteksi sangat sederhana GAS Apps Script exec
    if (p.indexOf('https://script.google.com/macros/s/') === 0) gas.push(p);
    else others.push(p);
  }
  // jika ada GAS, taruh di depan, lalu sisanya; jika tidak, biarkan
  if (gas.length) {
    // dedupe lagi untuk berjaga-jaga
    var combined = gas.concat(others);
    var seen = Object.create(null);
    var out = [];
    for (var j=0;j<combined.length;j++){
      var q = combined[j];
      if (!seen[q]) { seen[q] = 1; out.push(q); }
    }
    return out.join('|');
  }
  return s;
}

// ===== Override dari window.CONFIG (jika ada) =====
(function applyRuntimeConfig(){
  try{
    if (typeof window === 'undefined') return;
    var cfg = window.CONFIG || {};

    // BASE (Order)
    if (cfg.BASE != null) {
      var nb = normalizeBase(cfg.BASE);
      if (nb) BASE = nb;
    }

    // SHIP_BASE + alias
    var shipCandidate = null;
    if (cfg.SHIP_BASE != null) shipCandidate = cfg.SHIP_BASE;
    else if (cfg.BASE_ONGKIR != null) shipCandidate = cfg.BASE_ONGKIR;
    else if (cfg.ONGKIR_BASE != null) shipCandidate = cfg.ONGKIR_BASE;
    if (shipCandidate != null) {
      var ns = normalizeBase(shipCandidate);
      if (ns) SHIP_BASE = ns;
    }

    // PIN / ADMIN_PIN
    if (cfg.PIN != null)       ADMIN_PIN = String(cfg.PIN);
    if (cfg.ADMIN_PIN != null) ADMIN_PIN = String(cfg.ADMIN_PIN);

    // TOKEN / IMAGE PROXY
    if (cfg.ADMIN_TOKEN != null)    ADMIN_TOKEN = String(cfg.ADMIN_TOKEN);
    if (cfg.CF_IMAGE_PROXY != null) CF_IMAGE_PROXY = trimStr(cfg.CF_IMAGE_PROXY).replace(/\/+$/,'');

  }catch(_){
    // no-op
  }

  // Jaga-jaga: pastikan BASE meletakkan GAS Orders di depan untuk pencatatan
  BASE = ensureGasFirstForOrders(normalizeBase(BASE));
  // SHIP_BASE cukup normalize + dedupe
  SHIP_BASE = normalizeBase(SHIP_BASE);
})();

// ===== Exports =====
export {
  BASE, SHIP_BASE, ADMIN_PIN, ADMIN_TOKEN, CF_IMAGE_PROXY,
  BEST_CATEGORY, STRIP_CATEGORY,
  MENU_CACHE_KEY, MENU_CACHE_TTL
};
