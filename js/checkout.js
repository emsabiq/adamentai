'use strict';
// Checkout & Promo: kontrol promo, validasi input, drawer mobile, submit order (ES2019-safe)

import { byId, toast } from './utils.js';
import { State, Store, calcTotals } from './state.js';
import { Api } from './api.js';

/* =====================
 * KONST & UTIL
 * ===================== */
var MIN_PICKUP_MINUTES = 30;

function onlyDigits(s){
  return String(s == null ? '' : s).replace(/[^\d]/g,'');
}
function pad2(n){ n = Number(n)||0; return (n<10?'0':'') + n; }
function yyyymmddHHMM(){
  var d=new Date();
  return d.getFullYear().toString()
       + pad2(d.getMonth()+1)
       + pad2(d.getDate())
       + pad2(d.getHours())
       + pad2(d.getMinutes())
       + pad2(d.getSeconds());
}
function genOrderId(){ return 'WEB-' + yyyymmddHHMM() + '-' + Math.floor(Math.random()*900+100); }
function hhmmNow(){ var d=new Date(); return pad2(d.getHours())+':'+pad2(d.getMinutes()); }
function plusMinutes(date, m){ var d=new Date(date.getTime()); d.setMinutes(d.getMinutes()+m); return d; }
function parseHHMMToDate(hhmm){ var p=String(hhmm||'').split(':'); var d=new Date(); if (p.length<2) return null; d.setHours(parseInt(p[0],10)||0, parseInt(p[1],10)||0, 0, 0); return d; }

/* =====================
 * PROMO
 * ===================== */
function togglePromoControls(){
  var has = !!State.coupon;

  var ids = ['promo_code','promo_code_m'];
  for (var i=0;i<ids.length;i++){
    var el = byId(ids[i]);
    if (el) el.readOnly = has;
  }
  var btns = ['btnPromo','btnPromo_m'];
  for (var j=0;j<btns.length;j++){
    var b = byId(btns[j]);
    if (b) b.disabled = has;
  }
  var clrs = ['btnPromoClear','btnPromoClear_m'];
  for (var k=0;k<clrs.length;k++){
    var c = byId(clrs[k]);
    if (c) c.hidden = !has;
  }
}
function clearCoupon(){ if (!State.coupon) return; State.coupon = null; togglePromoControls(); toast('Kode promo dihapus'); }

async function applyCoupon(code){
  var clean = (code || '').trim();
  if (!clean) return toast('Masukkan kode promo');

  // Untuk validasi promo, cukup kirim id/qty/price base (flatten add-on tidak wajib di tahap ini)
  var items = (State.cart || []).map(function(c){ return { id:c.id, qty:c.qty, price:c.price }; });
  var payload = { code: clean, items: items };

  var res = null;
  try { res = await Api.promoValidate(payload); } catch (_e) { res = null; }

  var ok = !!(res && (res.ok || res.valid || res.status === 'ok'));
  if (!ok){
    try{
      if (typeof window !== 'undefined' && window.CONFIG && window.CONFIG.PROMO_LOCAL_FALLBACK){
        var fbmap = { 'HEMAT10': { type:'percent', value:10 }, 'POTONG5': { type:'flat', value:5000 } };
        var fb = fbmap[clean.toUpperCase()];
        if (fb){
          State.coupon = { code: clean.toUpperCase(), type: fb.type, value: fb.value };
          togglePromoControls();
          toast('Kode promo diterapkan (fallback)');
          return;
        }
      }
    }catch(_){}

    State.coupon = null;
    togglePromoControls();
    toast((res && res.error) || 'Kode promo tidak valid');
    return;
  }

  var data = res.data || res;
  var t = String(data.type || '').toLowerCase();
  var v = Number(data.value || 0);
  if (!t || !(v > 0)){
    State.coupon = null;
    togglePromoControls();
    toast('Respon promo tidak valid');
    return;
  }

  State.coupon = { code: clean.toUpperCase(), type: t, value: v };
  togglePromoControls();
  toast('Kode promo diterapkan');
}

/* =====================
 * CHECKOUT UI HELPERS
 * ===================== */
function setCheckoutLoading(loading){
  var ids = ['btnCheckout','btnCheckoutBar','btnCheckoutMobile'];
  for (var i=0;i<ids.length;i++){
    var btn = byId(ids[i]); if (!btn) continue;
    btn.disabled = true;
    btn.classList.toggle('is-loading', !!loading);
    if (loading){
      if (!btn.dataset._html) btn.dataset._html = btn.innerHTML;
      var label = (btn.textContent || 'Bayar').trim();
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + label;
    } else {
      btn.disabled = !(State.cart && State.cart.length);
      if (btn.dataset._html){ btn.innerHTML = btn.dataset._html; delete btn.dataset._html; }
    }
  }
}

function firstMissingField(desktop){
  var nameEl  = desktop ? byId('cust_name')  : document.querySelector('#cartDrawer #cust_name_m');
  var phoneEl = desktop ? byId('cust_phone') : document.querySelector('#cartDrawer #cust_phone_m');
  var addrEl  = desktop ? byId('cust_addr')  : document.querySelector('#cartDrawer #cust_addr_m');

  if (!nameEl || !String(nameEl.value || '').trim())  return { el:nameEl,  msg:'Nama wajib diisi' };
  if (!phoneEl || !String(phoneEl.value || '').trim()) return { el:phoneEl, msg:'No. HP wajib diisi' };

  var mode = (State && State.shipping && State.shipping.mode) ? State.shipping.mode : 'delivery';
  if (mode !== 'pickup' && (!addrEl || !String(addrEl.value || '').trim()))  return { el:addrEl,  msg:'Alamat wajib diisi' };
  return null;
}

function showFieldError(el,msg){
  toast(msg);
  if (!el) return;
  var inDrawer = !!(el.closest && el.closest('#cartDrawer'));
  var det = inDrawer
    ? document.querySelector('#cartDrawer details.collapsible')
    : document.querySelector('aside.cart details.collapsible');
  if (det && !det.open) det.open = true;

  if (inDrawer){
    var cont = document.querySelector('#cartDrawer .drawer__customer');
    if (cont){
      var top = el.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop - 12;
      try { cont.scrollTo({ top: top, behavior:'smooth' }); } catch(_){ cont.scrollTop = top; }
    }
  } else {
    try { el.scrollIntoView({ block:'center', behavior:'smooth' }); } catch(_){}
  }

  el.classList.add('field-error');
  try{ el.focus({ preventScroll:true }); }catch(_){}
  setTimeout(function(){ el.classList.remove('field-error'); }, 1500);
}

/* =====================
 * DRAWER (mobile)
 * ===================== */
function openDrawer(){
  var dw = byId('cartDrawer'); if (!dw) return;
  dw.classList.add('open');
  dw.removeAttribute('aria-hidden');
  dw.removeAttribute('inert');
  var c = byId('btnCloseCart'); if (c) try{ c.focus({ preventScroll:true }); }catch(_){}
}
function closeDrawer(){
  var dw = byId('cartDrawer'); if (!dw) return;
  if (dw.contains(document.activeElement)) {
    var o = byId('btnOpenCart'); if (o) try{ o.focus({ preventScroll:true }); }catch(_){}
  }
  dw.classList.remove('open');
  dw.setAttribute('aria-hidden','true');
  dw.setAttribute('inert','');
}

/* =====================
 * REQUIRED INPUT MARKER
 * ===================== */
function markRequiredInputs(){
  var pairs = [
    ['cust_name',null],['cust_phone',null],['cust_addr',null],
    ['cust_name_m','#cartDrawer'],['cust_phone_m','#cartDrawer'],['cust_addr_m','#cartDrawer']
  ];
  for (var i=0;i<pairs.length;i++){
    var id = pairs[i][0], scope = pairs[i][1];
    var sel = scope ? document.querySelector(scope + ' #' + id) : byId(id);
    if (sel){
      sel.required = true;
      if (!sel.placeholder){
        if (id.indexOf('name')>=0) sel.placeholder = 'Nama *';
        else if (id.indexOf('phone')>=0) sel.placeholder = 'No. HP *';
        else sel.placeholder = 'Alamat *';
      }
    }
  }
}

/* =====================
 * GATE: wajib ada QUOTE valid sebelum submit
 * ===================== */
async function ensureShippingReadyOrFail(){
  var ship = (State && State.shipping) ? State.shipping : {};
  var mode = ship && ship.mode ? ship.mode : 'delivery';

  if (mode === 'pickup') return true;

  if (!ship || !ship.dest) {
    toast('Pilih lokasi pengantaran terlebih dahulu');
    return false;
  }

  // Jika sedang kalkulasi → tunggu/paksa
  if (ship._quoting && window && window.__shipping && typeof window.__shipping.requestQuoteNow === 'function'){
    try{ await window.__shipping.requestQuoteNow(9000); }catch(_){}
  }
  // Belum punya quote → paksa hitung
  if (!(ship && ship.quote) && window && window.__shipping && typeof window.__shipping.requestQuoteNow === 'function'){
    try{ await window.__shipping.requestQuoteNow(9000); }catch(_){}
  }

  ship = (State && State.shipping) ? State.shipping : {};
  var hasQuote = !!(ship && ship.quote);
  var deliverable = hasQuote && !(ship.quote && ship.quote.deliverable === false);
  var feeNum = Number(ship.fee);

  if (!hasQuote) { toast('Ongkir belum terhitung. Mohon tunggu sebentar lalu coba lagi.'); return false; }
  if (!deliverable) { toast('Alamat di luar jangkauan pengantaran'); return false; }
  if (!isFinite(feeNum) || feeNum < 0) { toast('Ongkir belum valid. Coba lagi.'); return false; }

  return true;
}

/* =====================
 * Guard global (tambahan) — blokir klik/submit kalau belum siap
 * ===================== */
function installCheckoutClickGuard(){
  if (document.__checkoutClickGuardInstalled) return;
  document.addEventListener('click', function(e){
    var t=e.target;
    if (!t) return;
    var el = t.closest && t.closest('#btnCheckout, #btnCheckoutBar, #btnCheckoutMobile, [data-checkout], .js-checkout, button[name="checkout"], button[data-action="checkout"], a[href*="checkout"], a[href*="payment"], a[href*="pay"]');
    if (!el) return;

    try{
      if (window && window.__shipping && typeof window.__shipping.isReadyForCheckout === 'function'){
        if (!window.__shipping.isReadyForCheckout()){
          e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
          toast('Ongkir belum terhitung. Mohon tunggu…');
          try{ window.__shipping.requestQuoteNow(7000); }catch(_){}
        }
      }
    }catch(_){}
  }, true);

  document.addEventListener('submit', function(e){
    try{
      if (window && window.__shipping && typeof window.__shipping.isReadyForCheckout === 'function'){
        if (!window.__shipping.isReadyForCheckout()){
          e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
          toast('Ongkir belum terhitung. Mohon tunggu…');
          try{ window.__shipping.requestQuoteNow(7000); }catch(_){}
        }
      }
    }catch(_){}
  }, true);

  document.__checkoutClickGuardInstalled = true;
}

/* =====================
 * FLATTEN ITEMS (opsi & add-on)
 * ===================== */
/**
 * Mengonversi State.cart menjadi array baris sederhana untuk payload:
 * - Baris base item: price = base price + opt.price_delta (jika ada)
 * - Setiap add-on menjadi baris item terpisah: qty = item.qty * addon.qty, price = addon.price
 * Keluaran: [{ id, name, qty, price }, ...]
 * Plus metadata arsip: cart_detail (opsi & add-on per item)
 */
function buildPayloadItemsFromCart(){
  var out = [];
  var detail = [];

  var cart = State.cart || [];
  for (var i=0;i<cart.length;i++){
    var c = cart[i] || {};
    var id = c.id;
    var name = String(c.name || '');
    var qty = Number(c.qty || 0);
    var basePrice = Number(c.price || 0);

    // opsi (opsional)
    var opt = c.opt || null;
    var optDelta = (opt && opt.price_delta != null) ? Number(opt.price_delta) : 0;
    var unitPriceWithOpt = basePrice + optDelta;

    // Baris base item
    if (qty > 0) {
      out.push({
        id: id,
        name: name,             // nama base (tidak kita ubah agar mapping tetap)
        qty: qty,
        price: unitPriceWithOpt // sudah termasuk opsi
      });
    }

    // Arsip detail untuk base
    var rowDetail = {
      id: id,
      name: name,
      qty: qty,
      base_price: basePrice,
      opt_label: opt ? (opt.label || opt.key || '') : '',
      opt_price_delta: optDelta,
      addons: []
    };

    // Add-on → flatten jadi baris item terpisah
    var addons = Array.isArray(c.addons) ? c.addons : [];
    for (var j=0;j<addons.length;j++){
      var a = addons[j] || {};
      var aid = (a.id != null) ? a.id : (a.code != null ? a.code : String(a.name || ''));
      var aname = String(a.name || a.label || '');
      var aunitPrice = Number(a.price || 0);
      var aqPerUnit = Number(a.qty || 0); // qty add-on per 1 unit item utama
      if (!aname || aqPerUnit <= 0) continue;

      var flatQty = Math.max(0, Math.floor(qty * aqPerUnit));
      if (flatQty > 0){
        out.push({
          id: aid,              // gunakan id add-on asli (tanpa prefix) agar sederhana
          name: aname,
          qty: flatQty,
          price: aunitPrice
        });
      }

      rowDetail.addons.push({
        id: aid,
        name: aname,
        price: aunitPrice,
        qty_per_unit: aqPerUnit,
        flattened_qty: flatQty
      });
    }

    detail.push(rowDetail);
  }

  return { items: out, cart_detail: detail };
}

/* =====================
 * CHECKOUT (submit)
 * ===================== */
async function checkout(desktop){
  if (desktop === void 0) desktop = true;
  if (!(State.cart && State.cart.length)) return toast('Keranjang kosong');

  if (checkout._pending) return;
  checkout._pending = true;
  setCheckoutLoading(true); // spinner ON

  try{
    var miss = firstMissingField(desktop);
    if (miss){
      if (!desktop){ openDrawer(); setTimeout(function(){ showFieldError(miss.el, miss.msg); }, 120); }
      else { showFieldError(miss.el, miss.msg); }
      return;
    }

    var ship = (State && State.shipping) ? State.shipping : {};
    var mode = ship.mode || 'delivery';

    if (mode === 'delivery'){
      if (!ship.dest){
        toast('Pilih lokasi pengantaran terlebih dahulu');
        try{ openDrawer(); }catch(_){}
        return;
      }
      var okShip = await ensureShippingReadyOrFail();
      if (!okShip) return;
    } else if (mode === 'pickup'){
      var t = String(ship.pickup_time || '').trim();
      var tDate = parseHHMMToDate(t);
      var minDate = plusMinutes(new Date(), MIN_PICKUP_MINUTES);
      if (!tDate || tDate < minDate){
        toast('Waktu ambil minimal ' + MIN_PICKUP_MINUTES + ' menit dari sekarang');
        try{ openDrawer(); }catch(_){}
        return;
      }
    }

    var nameEl   = desktop ? byId('cust_name')   : byId('cust_name_m');
    var addrEl   = desktop ? byId('cust_addr')   : byId('cust_addr_m');
    var phoneEl  = desktop ? byId('cust_phone')  : byId('cust_phone_m');
    var noteEl   = desktop ? byId('cust_note')   : byId('cust_note_m');

    var name  = (nameEl  && nameEl.value)  ? String(nameEl.value).trim()  : '';
    var addr  = (addrEl  && addrEl.value)  ? String(addrEl.value).trim()  : '';
    var phone = (phoneEl && phoneEl.value) ? String(phoneEl.value).trim() : '';
    var note  = (noteEl  && noteEl.value)  ? String(noteEl.value).trim()  : '';

    var phoneDigits = onlyDigits(phone) || phone;

    var totals = calcTotals();
    var subtotal = totals.subtotal, discount = totals.discount, total = totals.total;

    ship = (State && State.shipping) ? State.shipping : {};
    mode = ship.mode || 'delivery';

    var shippingFee = Number(ship.fee || 0);
    if (mode === 'pickup') shippingFee = 0;
    if (!(shippingFee >= 0) || !isFinite(shippingFee)) shippingFee = 0;

    if (mode === 'delivery' && ship.quote && ship.quote.deliverable === false) {
      toast('Alamat di luar jangkauan pengantaran');
      return;
    }

    var lat = null, lng = null;
    if (ship.dest && typeof ship.dest.lat !== 'undefined' && typeof ship.dest.lng !== 'undefined') {
      lat = Number(ship.dest.lat); if (isNaN(lat)) lat = null;
      lng = Number(ship.dest.lng); if (isNaN(lng)) lng = null;
    }

    var localOrderId = genOrderId();

    // === FLATTEN ITEMS ===
    var built = buildPayloadItemsFromCart(); // { items, cart_detail }

    var payload = {
      order_id: localOrderId,
      customer_name: name,
      phone: phoneDigits,
      address: addr,
      note: note,
      info: '',

      // <-- Gunakan items yang sudah flattened (opsi masuk harga base; add-on sebagai baris terpisah)
      items: built.items,

      coupon_code: (State.coupon && State.coupon.code) ? State.coupon.code : '',
      discount_value: discount,

      subtotal: subtotal,                  // subtotal komprehensif (opsi+addon) dari state.calcTotals()
      total: total,                        // tanpa ongkir
      grand_total: (total + shippingFee),  // final + ongkir

      delivery_method: (mode === 'pickup' ? 'pickup' : 'delivery'),
      shipping_fee: shippingFee,
      shipping_address: (mode === 'delivery') ? (ship.address || '') : 'Ambil di Toko',
      address_text: (ship.address || addr || ''),
      lat: lat,
      lng: lng,

      shipping_mode: mode,
      shipping_dest: (mode === 'delivery') ? (ship.dest || null) : null,
      shipping_eta_min: (mode === 'delivery')
        ? (ship.eta_min != null ? ship.eta_min : (ship.route && ship.route.eta_min ? ship.route.eta_min : null))
        : null,
      shipping_distance_km: (mode === 'delivery')
        ? (ship.distance_km != null ? ship.distance_km : (ship.route && ship.route.distance_km ? ship.route.distance_km : null))
        : null,
      shipping_breakdown: ship.breakdown || null,
      shipping_quote: ship.quote || null,
      pickup_time_local: (mode === 'pickup') ? (ship.pickup_time || '') : '',
      finish_redirect_url: (typeof location !== 'undefined' ? location.href : '')
    };

    // Arsipkan konfigurasi lengkap (opsional tapi sangat berguna)
    try{
      payload.info = JSON.stringify({
        shipping: {
          mode: payload.shipping_mode,
          address: payload.shipping_address,
          dest: payload.shipping_dest,
          fee: payload.shipping_fee,
          eta_min: payload.shipping_eta_min,
          distance_km: payload.shipping_distance_km,
          pickup_time: payload.pickup_time_local
        },
        cart_detail: built.cart_detail,  // opsi + add-on per item (untuk arsip)
        meta: { created_at_local: hhmmNow() }
      });
    }catch(_){ payload.info = ''; }

    var j = null;
    try { j = await Api.createOrder(payload); } catch (_e) { j = null; }

    if (j && j.paymentUrl){
      try{ localStorage.setItem('adm_customer', JSON.stringify({name:name, phone:phoneDigits, addr:addr})); }catch(_){}
      try { window.dispatchEvent(new CustomEvent('order:created', { detail:{ order_id: j.id || localOrderId, paymentUrl: j.paymentUrl } })); } catch(_){}
      try { location.href = j.paymentUrl; } catch(_){}
      return;
    }

    if (j && (j.ok || j.status === 'ok' || j.id)){
      toast('Pesanan dibuat.');
      try { window.dispatchEvent(new CustomEvent('order:created', { detail:{ order_id: j.id || localOrderId } })); } catch(_){}
      try { State.cart = []; Store.save(); } catch(_){}
      return;
    }

    var err = (j && j.error) || 'Gagal membuat transaksi';
    if (err === 'midtrans_error') err = 'Pembayaran tidak tersedia. Coba lagi.';
    toast(err);
    try { window.dispatchEvent(new CustomEvent('order:failed', { detail:{ msg: err } })); } catch(_){}

  } catch (err){
    try { console.error('checkout error', err); } catch(_){}
    toast('Terjadi kesalahan jaringan');
    try { window.dispatchEvent(new CustomEvent('order:failed', { detail:{ msg: 'network' } })); } catch(_){}
  } finally {
    checkout._pending = false;
    setCheckoutLoading(false); // spinner OFF
  }
}

/* Pasang guard global saat halaman siap */
document.addEventListener('DOMContentLoaded', installCheckoutClickGuard);

export {
  togglePromoControls,
  clearCoupon,
  applyCoupon,
  setCheckoutLoading,
  firstMissingField,
  showFieldError,
  openDrawer,
  closeDrawer,
  markRequiredInputs,
  checkout,
};
