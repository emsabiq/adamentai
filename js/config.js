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
 *     BASE: "https://midtrans-proxy...workers.dev|https://script.google.com/macros/s/....../exec",
 *     SHIP_BASE: "https://adamentai-ongkir-proxy...workers.dev|https://script.google.com/macros/s/....../exec",
 *     // alias yang juga diterima:
 *     BASE_ONGKIR: "...", ONGKIR_BASE: "...",
 *     ADMIN_PIN: "4321", ADMIN_TOKEN: "secret", CF_IMAGE_PROXY: "https://img.example.com"
 *   }
 */

// ===== Default (boleh di-override via window.CONFIG) =====

// Order/Midtrans (Worker → fallback Apps Script Order)
var BASE =
  'https://midtrans-proxy.msabiq-stan.workers.dev' +
  '|' +
  'https://script.google.com/macros/s/AKfycbzKtWlxd_I4x-o7gnPy7spjSoMxDZm01VtrRlHPD5yd3tvKq6X3t19ZM4-qUVT6dF8K/exec';

// Ongkir (Worker → fallback Apps Script Ongkir)
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

// Gabungkan BASE menjadi string pipe ("a|b|c") terlepas dari input (string/array)
function normalizeBase(input){
  if (isArray(input)) {
    var parts = [];
    for (var i=0;i<input.length;i++){
      var v = trimStr(input[i]);
      if (v) parts.push(v.replace(/\/+$/,''));
    }
    return parts.join('|');
  }
  if (isString(input)) {
    var s = trimStr(input);
    if (!s) return '';
    var tokens = s.split('|').join(',').split(',');
    var out = [];
    for (var j=0;j<tokens.length;j++){
      var t = trimStr(tokens[j]);
      if (t) out.push(t.replace(/\/+$/,''));
    }
    return out.join('|');
  }
  return '';
}

// ===== Override dari window.CONFIG (jika ada) =====
(function applyRuntimeConfig(){
  try{
    if (typeof window === 'undefined') return;
    var cfg = window.CONFIG || {};

    if (cfg.BASE) {
      var nb = normalizeBase(cfg.BASE);
      if (nb) BASE = nb;
    }

    // SHIP_BASE + alias
    var shipCandidate = cfg.SHIP_BASE || cfg.BASE_ONGKIR || cfg.ONGKIR_BASE;
    if (shipCandidate) {
      var ns = normalizeBase(shipCandidate);
      if (ns) SHIP_BASE = ns;
    }

    // Terima alias PIN / ADMIN_PIN
    if (cfg.PIN != null)       ADMIN_PIN = String(cfg.PIN);
    if (cfg.ADMIN_PIN != null) ADMIN_PIN = String(cfg.ADMIN_PIN);

    if (cfg.ADMIN_TOKEN != null)    ADMIN_TOKEN = String(cfg.ADMIN_TOKEN);
    if (cfg.CF_IMAGE_PROXY != null) CF_IMAGE_PROXY = trimStr(cfg.CF_IMAGE_PROXY).replace(/\/+$/,'');

  }catch(_){
    // no-op
  }
})();

// ===== Exports =====
export {
  BASE, SHIP_BASE, ADMIN_PIN, ADMIN_TOKEN, CF_IMAGE_PROXY,
  BEST_CATEGORY, STRIP_CATEGORY,
  MENU_CACHE_KEY, MENU_CACHE_TTL
};
