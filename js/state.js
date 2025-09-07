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

  // Cart disimpan sebagai ARRAY agar backward compatible:
  // item lama: {id, name, price, qty}
  // item baru: {id, name, price, qty, opt?, addons?}
  cart: [],

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
function _num(n){ var x = Number(n); return (isFinite(x) ? x : 0); }
function _int(n){ var x = parseInt(n,10); return (isFinite(x) ? x : 0); }
function _clone(o){ return JSON.parse(JSON.stringify(o || {})); }
function _sortById(a,b){
  var aa = (a && a.id != null) ? String(a.id) : '';
  var bb = (b && b.id != null) ? String(b.id) : '';
  if (aa < bb) return -1; if (aa > bb) return 1; return 0;
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
 * Cart normalizer + helpers (opsi & add-on)
 * ===================== */

/**
 * Skema cart (normal):
 * {
 *   id: string|number,
 *   name: string,
 *   price: number,       // base price per unit
 *   qty: number,         // qty item utama
 *   opt: { key: string, label: string, price_delta?: number } | null,
 *   addons: Array<{ id: string|number, name: string, price: number, qty: number }>
 * }
 *
 * Catatan:
 * - addons[i].qty = jumlah add-on **per 1 unit** item utama (bukan total).
 * - Total add-on pada baris = (sum(addon.price * addon.qty)) * item.qty
 */
function normalizeCartItem(raw){
  var it = raw || {};
  var out = {
    id: (it.id != null) ? it.id : '',
    name: String(it.name || ''),
    price: _num(it.price),
    qty: Math.max(1, _int(it.qty || 1)),
    opt: null,
    addons: []
  };

  // Backward compatible: tidak ada opt/addons
  if (it.opt){
    // opt bisa string label atau object
    if (typeof it.opt === 'string'){
      out.opt = { key: it.opt, label: it.opt, price_delta: 0 };
    } else {
      var k  = (it.opt.key != null) ? String(it.opt.key)
              : (it.opt.label ? String(it.opt.label) : '');
      var lb = it.opt.label ? String(it.opt.label) : String(k || '');
      var pd = (it.opt.price_delta != null) ? _num(it.opt.price_delta)
              : (it.opt.priceDelta != null) ? _num(it.opt.priceDelta)
              : 0;
      out.opt = { key: k, label: lb, price_delta: pd };
    }
  }

  if (it.addons && it.addons.length){
    var arr = [];
    for (var i=0;i<it.addons.length;i++){
      var a = it.addons[i] || {};
      var aid = (a.id != null) ? a.id : (a.code != null ? a.code : String(a.name || ''));
      var nm  = String(a.name || a.label || '');
      var pr  = _num(a.price);
      var q   = Math.max(0, _int(a.qty || 0));
      if (nm && q > 0){
        arr.push({ id: aid, name: nm, price: pr, qty: q });
      }
    }
    arr.sort(_sortById); // stabil untuk key
    out.addons = arr;
  }

  return out;
}

/**
 * buildCartKey(id, opt, addons)
 * - opt: {key,...} | null
 * - addons: array of {id, qty}; diurutkan by id agar stabil
 * => "<id>|opt:<key>|a:<id>x<qty>,<id>x<qty>..."
 */
function buildCartKey(id, opt, addons){
  var idStr = String(id != null ? id : '');
  var optKey = (opt && opt.key != null) ? String(opt.key) : '-';

  var sig = [];
  if (addons && addons.length){
    var cp = addons.slice().sort(_sortById);
    for (var i=0;i<cp.length;i++){
      var a = cp[i] || {};
      var aid = (a.id != null) ? String(a.id) : '';
      var aq  = Math.max(0, _int(a.qty || 0));
      if (aid && aq > 0) sig.push(aid + 'x' + aq);
    }
  }
  var addSig = sig.join(',');

  return idStr + '|opt:' + optKey + '|a:' + addSig;
}

/**
 * computeLineTotals(item)
 * return:
 * {
 *   unit_base: number,         // harga base per unit (+opt delta)
 *   addons_per_unit: number,   // total addon per unit
 *   unit_total: number,        // per unit (base + addons_per_unit)
 *   qty: number,               // qty item utama
 *   addons_total: number,      // addons_per_unit * qty
 *   line_subtotal: number      // unit_total * qty
 * }
 */
function computeLineTotals(item){
  var it = normalizeCartItem(item);

  var optDelta = (it.opt && it.opt.price_delta != null) ? _num(it.opt.price_delta) : 0;
  var unitBase = _num(it.price) + optDelta;

  var addPerUnit = 0;
  for (var i=0;i<it.addons.length;i++){
    var a = it.addons[i];
    addPerUnit += _num(a.price) * Math.max(0, _int(a.qty));
  }

  var unitTotal = unitBase + addPerUnit;
  var qty = Math.max(1, _int(it.qty));
  var addonsTotal = addPerUnit * qty;
  var lineSubtotal = unitTotal * qty;

  return {
    unit_base: unitBase,
    addons_per_unit: addPerUnit,
    unit_total: unitTotal,
    qty: qty,
    addons_total: addonsTotal,
    line_subtotal: lineSubtotal
  };
}

/* =====================
 * Store (localStorage)
 * ===================== */
var Store = {
  load: function(){
    try {
      var raw = localStorage.getItem('adm_cart') || '[]';
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];

      // normalisasi setiap item agar ada field opt/addons konsisten
      var norm = [];
      for (var i=0;i<arr.length;i++){
        norm.push(normalizeCartItem(arr[i]));
      }
      State.cart = norm;
    } catch (e) {
      State.cart = [];
    }
  },
  save: function(){
    try {
      // simpan versi normalized agar konsisten
      var out = [];
      for (var i=0;i<(State.cart || []).length;i++){
        out.push(normalizeCartItem(State.cart[i]));
      }
      localStorage.setItem('adm_cart', JSON.stringify(out));
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
  // subtotal dihitung per-baris menggunakan computeLineTotals (termasuk addon & optDelta)
  var subtotal = 0;
  var cart = State.cart || [];
  for (var i=0;i<cart.length;i++){
    var line = computeLineTotals(cart[i]);
    subtotal += _num(line.line_subtotal);
  }

  var discount = 0;
  if (State.coupon){
    if (State.coupon.type === 'percent') {
      discount = Math.floor(subtotal * (_num(State.coupon.value) / 100));
    }
    if (State.coupon.type === 'flat') {
      discount = Math.min(subtotal, _num(State.coupon.value));
    }
  }

  var total = Math.max(0, subtotal - discount);
  return { subtotal: subtotal, discount: discount, total: total };
}

/* =====================
 * Re-exports for convenience
 * ===================== */
export {
  State,
  Store,
  buildCatIndex,
  normalizeCategory,
  normalizeMenuItem,
  getItemById,
  getStock,
  calcTotals,

  // helpers baru untuk Prioritas 1
  normalizeCartItem,
  buildCartKey,
  computeLineTotals
};

export { BEST_CATEGORY, STRIP_CATEGORY } from './config.js';
