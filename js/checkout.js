'use strict';
// Checkout & Promo: kontrol promo, validasi input, drawer mobile, submit order (ES2019-safe)

import { byId, toast } from './utils.js';
import { State, Store, calcTotals } from './state.js';
import { Api } from './api.js';

/* =====================
 * PROMO
 * ===================== */
function togglePromoControls(){
  var has = !!State.coupon;

  ['promo_code','promo_code_m'].forEach(function(id){
    var el = byId(id);
    if (el) el.readOnly = has;
  });
  ['btnPromo','btnPromo_m'].forEach(function(id){
    var b = byId(id);
    if (b) b.disabled = has;
  });
  ['btnPromoClear','btnPromoClear_m'].forEach(function(id){
    var b = byId(id);
    if (b) b.hidden = !has;
  });
}

function clearCoupon(){
  if (!State.coupon) return;
  State.coupon = null;
  togglePromoControls();
  toast('Kode promo dihapus');
}

async function applyCoupon(code){
  var clean = (code || '').trim();
  if (!clean) return toast('Masukkan kode promo');

  var items = (State.cart || []).map(function(c){ return { id:c.id, qty:c.qty, price:c.price }; });
  var payload = { code: clean, items: items };

  var res = null;
  try {
    res = await Api.promoValidate(payload);
  } catch (_e) {
    res = null;
  }

  var ok = !!(res && (res.ok || res.valid || res.status === 'ok'));
  if (!ok){
    // Opsional: fallback lokal bila CONFIG diaktifkan
    try{
      if (typeof window !== 'undefined' && window.CONFIG && window.CONFIG.PROMO_LOCAL_FALLBACK){
        var fbmap = {
          'HEMAT10': { type:'percent', value:10 },
          'POTONG5': { type:'flat', value:5000 }
        };
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
  if (!addrEl || !String(addrEl.value || '').trim())  return { el:addrEl,  msg:'Alamat wajib diisi' };
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
 * Utils (normalize)
 * ===================== */
function onlyDigits(s){
  return String(s == null ? '' : s).replace(/[^\d]/g,'');
}
function hhmmNow(){ var d=new Date(); return (''+d.getHours()).padStart(2,'0')+':'+(''+d.getMinutes()).padStart(2,'0'); }
function plusMinutes(date, m){ var d=new Date(date.getTime()); d.setMinutes(d.getMinutes()+m); return d; }
function parseHHMMToDate(hhmm){
  var p=String(hhmm||'').split(':'); var d=new Date();
  if (p.length<2) return null;
  d.setHours(parseInt(p[0],10)||0, parseInt(p[1],10)||0, 0, 0);
  return d;
}

/* =====================
 * CHECKOUT (submit)
 * ===================== */
async function checkout(desktop){
  if (desktop === void 0) desktop = true;
  if (!(State.cart && State.cart.length)) return toast('Keranjang kosong');

  // rate-limit klik beruntun
  if (checkout._pending) return;
  checkout._pending = true;
  setCheckoutLoading(true);

  try{
    var miss = firstMissingField(desktop);
    if (miss){
      if (!desktop){ openDrawer(); setTimeout(function(){ showFieldError(miss.el, miss.msg); }, 120); }
      else { showFieldError(miss.el, miss.msg); }
      return;
    }

    var nameEl   = desktop ? byId('cust_name')   : byId('cust_name_m');
    var addrEl   = desktop ? byId('cust_addr')   : byId('cust_addr_m');
    var phoneEl  = desktop ? byId('cust_phone')  : byId('cust_phone_m');
    var noteEl   = desktop ? byId('cust_note')   : byId('cust_note_m');

    var name  = (nameEl  && nameEl.value)  ? String(nameEl.value).trim()  : '';
    var addr  = (addrEl  && addrEl.value)  ? String(addrEl.value).trim()  : '';
    var phone = (phoneEl && phoneEl.value) ? String(phoneEl.value).trim() : '';
    var note  = (noteEl  && noteEl.value)  ? String(noteEl.value).trim()  : '';

    // Normalisasi HP: digit saja (server boleh tetap menerima format bebas)
    var phoneDigits = onlyDigits(phone) || phone;

    // totals dari state (tanpa ongkir)
    var totals = calcTotals();
    var subtotal = totals.subtotal, discount = totals.discount, total = totals.total;

    // detail ongkir dari State.shipping (diisi oleh shipping.js)
    var ship = (State && State.shipping) ? State.shipping : (typeof window !== 'undefined' && window.State ? (window.State.shipping || {}) : {});
    ship = ship || {};
    var mode = ship.mode || 'delivery';

    // ===== Validasi mode & input pengiriman/pickup =====
    if (mode === 'delivery'){
      if (!ship.dest){
        toast('Pilih lokasi pengantaran terlebih dahulu');
        try{ openDrawer(); }catch(_){}
        return;
      }
    } else if (mode === 'pickup'){
      var t = String(ship.pickup_time || '').trim();
      var tDate = parseHHMMToDate(t);
      var minDate = plusMinutes(new Date(), 30);
      if (!tDate || tDate < minDate){
        toast('Waktu ambil minimal 30 menit dari sekarang');
        try{ openDrawer(); }catch(_){}
        return;
      }
    }

    var shippingFee = Number(ship.fee || 0);
    if (!(shippingFee >= 0)) shippingFee = 0;

    // Payload standar (kompatibel) + field baru untuk logging yang jelas
    var payload = {
      customer_name: name,
      phone: phoneDigits,
      address: addr,            // alamat customer untuk kwitansi
      note: note,
      info: '',                 // akan diisi di bawah (fallback logging)

      items: (State.cart || []).map(function(c){
        return { id: c.id, name: c.name, qty: c.qty, price: c.price };
      }),

      coupon_code: (State.coupon && State.coupon.code) ? State.coupon.code : '',
      discount_value: discount,

      subtotal: subtotal,
      total: total,                        // tanpa ongkir
      grand_total: (total + shippingFee),  // untuk penagihan

      // ======== tambahan ongkir yang lama (kompatibel) ========
      shipping_fee: shippingFee,
      shipping_dest: (mode === 'delivery') ? (ship.dest || null) : null,
      shipping_eta_min: (mode === 'delivery')
        ? (ship.eta_min != null ? ship.eta_min : (ship.route && ship.route.eta_min ? ship.route.eta_min : null))
        : null,
      shipping_distance_km: (mode === 'delivery')
        ? (ship.distance_km != null ? ship.distance_km : (ship.route && ship.route.distance_km ? ship.route.distance_km : null))
        : null,
      shipping_breakdown: ship.breakdown || null,
      shipping_quote: ship.quote || null,
      shipping_address: (mode === 'delivery') ? (ship.address || '') : 'Ambil di Toko',

      // ======== field BARU agar pencatatan jelas di Google Sheet/API ========
      shipping_mode: mode,                                  // 'delivery' | 'pickup'
      pickup_time_local: (mode === 'pickup') ? (ship.pickup_time || '') : '',

      // redirect setelah selesai
      finish_redirect_url: (typeof location !== 'undefined' ? location.href : '')
    };

    // Fallback: taruh ringkasan ke "info" agar tetap tercatat walau backend belum mapping field baru
    try{
      payload.info = JSON.stringify({
        shipping: {
          mode: payload.shipping_mode,
          address: payload.shipping_address,
          dest: payload.shipping_dest,
          fee: payload.shipping_fee,
          pickup_time: payload.pickup_time_local
        },
        meta: { created_at_local: hhmmNow() }
      });
    }catch(_){ payload.info = ''; }

    var j = null;
    try { j = await Api.createOrder(payload); } catch (_e) { j = null; }

    if (j && j.paymentUrl){
      // simpan customer untuk prefilling selanjutnya
      try{
        localStorage.setItem('adm_customer', JSON.stringify({name:name, phone:phoneDigits, addr:addr}));
      }catch(_){}
      // redirect ke Midtrans
      try { location.href = j.paymentUrl; } catch(_){}
      return;
    }

    // Kalau server tidak mengembalikan paymentUrl, tetap anggap order tercatat
    if (j && (j.ok || j.status === 'ok' || j.id)){
      toast('Pesanan dibuat.');
      return;
    }

    var err = (j && j.error) || 'Gagal membuat transaksi';
    toast(err === 'midtrans_error' ? 'Pembayaran tidak tersedia. Coba lagi.' : err);

  } catch (err){
    try { console.error('checkout error', err); } catch(_){}
    toast('Terjadi kesalahan jaringan');
  } finally {
    checkout._pending = false;
    setCheckoutLoading(false);
  }
}

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
