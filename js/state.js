'use strict';
// Global app state + normalizers + helpers (no DOM here, ES2019-safe)

/* =====================
 * Public State
 * ===================== */
var State = {
  cats: [],          // [{id, name}]
  items: [],         // menu aktif (untuk katalog)
  itemsAdmin: [],    // semua menu (admin)
  selectedCat: '',   // chip/category terpilih (nama kategori)
  cart: [],          // [{id, name, price, qty}]
  coupon: null,      // { code, type:'percent'|'flat', value }
  shipping: null     // detail ongkir dari shipping.js (fee, dest, route, dst)
};

/* =====================
 * Index kategori (id -> name)
 * ===================== */
var catById = Object.create(null);

function buildCatIndex(list){
  catById = Object.create(null);
  (list || []).forEach(function(c){
    if (!c) return;
    var id = String(c.id);
    catById[id] = c.name;
  });
}

/* =====================
 * Helpers
 * ===================== */
function lowerKeys(obj){
  var out = {};
  if (!obj) return out;
  Object.keys(obj).forEach(function(k){
    out[String(k).toLowerCase()] = obj[k];
  });
  return out;
}

/* =====================
 * Normalizers (kategori & menu)
 * ===================== */
function normalizeCategory(c){
  var low = lowerKeys(c || {});
  var id =
      low.id != null ? low.id
    : (low.cat_id != null ? low.cat_id
    : (low.kategori_id != null ? low.kategori_id
    : (low.categoryid != null ? low.categoryid
    : (low.kode != null ? low.kode
    : (low.code != null ? low.code
    : (low.name != null ? low.name
    : (low.nama != null ? low.nama : null)))))));

  var name = (low.name != null ? low.name
            : (low.nama != null ? low.nama
            : (low.category != null ? low.category
            : (low.kategori != null ? low.kategori
            : (id != null ? id : '')))));
  name = String(name).trim();

  // Jika id kosong, pakai name sebagai id agar stabil
  var sid = (id == null || String(id).trim() === '') ? name : id;

  return { id: String(sid), name: name };
}

function normalizeMenuItem(x){
  var low = lowerKeys(x || {});

  // Ambil nama kategori langsung, atau map dari id -> name
  var catName = (function(){
    var v = (low.category != null ? low.category
            : (low.kategori != null ? low.kategori
            : (low.cat != null ? low.cat
            : (low.category_name != null ? low.category_name
            : (low.namakategori != null ? low.namakategori : '')))));
    v = String(v).trim();
    if (v) return v;

    var catId = (low.category_id != null ? low.category_id
                : (low.cat_id != null ? low.cat_id
                : (low.kategori_id != null ? low.kategori_id
                : (low.catid != null ? low.catid
                : (low.categoryid != null ? low.categoryid : null)))));
    if (catId != null) {
      var mapped = catById[String(catId)];
      if (mapped) return mapped;
    }
    return '';
  })();

  // Flag aktif
  var active = (function(){
    if (typeof low.active === 'string') return low.active.toUpperCase() === 'Y';
    if (typeof low.active === 'number') return !!low.active;
    if (typeof low.active === 'boolean') return low.active;
    if (typeof low.status === 'string') return low.status.toUpperCase() === 'Y';
    if (typeof low.status === 'number') return !!low.status;
    if (typeof low.status === 'boolean') return low.status;
    return false;
  })();

  // Price & stock
  var price = Number(
    (low.price != null ? low.price
    : (x && x.price != null ? x.price : 0))
  );

  var stock = Number(
    (low.stock != null ? low.stock
    : (low.stok != null ? low.stok
    : (x && x.stock != null ? x.stock : 0)))
  );

  var out = {};
  // copy original fields shallow
  if (x && typeof x === 'object') {
    Object.keys(x).forEach(function(k){ out[k] = x[k]; });
  }
  out.category = catName; // selalu nama kategori (bukan id)
  out.price = price;
  out.stock = stock;
  out.active = active;

  return out;
}

/* =====================
 * Store (localStorage)
 * ===================== */
var Store = {
  load: function(){
    try {
      var raw = localStorage.getItem('adm_cart') || '[]';
      State.cart = JSON.parse(raw);
      if (!Array.isArray(State.cart)) State.cart = [];
    } catch (e) {
      State.cart = [];
    }
  },
  save: function(){
    try {
      localStorage.setItem('adm_cart', JSON.stringify(State.cart));
    } catch (e) { /* ignore quota */ }
  }
};

/* =====================
 * Item helpers / stock
 * ===================== */
function getItemById(id){
  var sid = String(id);
  var a = (State.itemsAdmin || []).find(function(x){ return String(x.id) === sid; });
  if (a) return a;
  return (State.items || []).find(function(x){ return String(x.id) === sid; });
}
function getStock(id){
  var it = getItemById(id);
  var v = it && it.stock != null ? it.stock : 0;
  return Number(v);
}

/* =====================
 * Totals (cart + coupon)
 * ===================== */
function calcTotals(){
  var subtotal = (State.cart || []).reduce(function(s,c){
    return s + (Number(c.qty || 0) * Number(c.price || 0));
  }, 0);

  var discount = 0;
  if (State.coupon){
    if (State.coupon.type === 'percent') {
      discount = Math.floor(subtotal * (Number(State.coupon.value || 0)) / 100);
    }
    if (State.coupon.type === 'flat') {
      discount = Math.min(subtotal, Number(State.coupon.value || 0));
    }
  }

  var total = Math.max(0, subtotal - discount);
  return { subtotal: subtotal, discount: discount, total: total };
}

/* =====================
 * Re-exports for convenience
 * ===================== */
export { State, Store, buildCatIndex, normalizeCategory, normalizeMenuItem, getItemById, getStock, calcTotals };
export { BEST_CATEGORY, STRIP_CATEGORY } from './config.js';
