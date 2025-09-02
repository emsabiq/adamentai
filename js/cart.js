'use strict';
// Cart module: tambah/hapus item, render ringkasan & baris, validasi stok + promo (ES2019-safe)

import { byId, setText, setDisabled, updateCartBadges, toast, money } from './utils.js';
import { State, Store, getStock } from './state.js';
import { Api } from './api.js';
import { togglePromoControls } from './checkout.js';

/* =================== Helpers =================== */
function clampInt(n, min, max){
  n = parseInt(String(n).replace(/[^\d-]/g,''), 10);
  if (isNaN(n)) n = 0;
  if (typeof min === 'number' && n < min) n = min;
  if (typeof max === 'number' && n > max) n = max;
  return n;
}
function setMoneyText(el, val, strike){
  if (!el) return;
  if (strike) el.innerHTML = '<s>' + money(val) + '</s>';
  else el.textContent = money(val);
}
function digitsToNumber(x){
  var s = String(x == null ? '' : x).replace(/[^\d.-]/g,'');
  var v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

/* =================== Minimum belanja dari kupon =================== */
function deepPickMin(obj){
  var best = 0;
  try{
    if (!obj || typeof obj !== 'object') return 0;
    var keys = Object.keys(obj);
    for (var i=0;i<keys.length;i++){
      var k = String(keys[i] || '').toLowerCase();
      var v = obj[keys[i]];
      if (typeof v === 'object' && v){
        var d = deepPickMin(v);
        if (d > best) best = d;
      } else {
        if (k === 'min' ||
            k.indexOf('min_') === 0 ||
            (k.indexOf('min') >= 0 && (
              k.indexOf('subtotal') >= 0 ||
              k.indexOf('total') >= 0 ||
              k.indexOf('order') >= 0 ||
              k.indexOf('belanja') >= 0 ||
              k.indexOf('purchase') >= 0
            ))) {
          var num = digitsToNumber(v);
          if (num > best) best = num;
        }
      }
    }
  }catch(_){}
  return best;
}
function getCouponMin(cp){
  if (!cp) return 0;
  var cands = [cp.min, cp.min_subtotal, cp.min_total, cp.minimum, cp.minPurchase, cp.min_order, cp.min_belanja, cp.minimum_amount];
  var best = 0;
  for (var i=0; i<cands.length; i++){
    var v = digitsToNumber(cands[i]);
    if (v > best) best = v;
  }
  return best;
}

/* =================== Hitung totals (perhitungkan coupon) =================== */
function calcTotalsLocal() {
  var subtotal = (State.cart || []).reduce(function (s, c) {
    return s + (Number(c.qty || 0) * Number(c.price || 0));
  }, 0);

  // Cek eligibility minimum belanja (copot instan bila tidak memenuhi)
  var cp = State.coupon;
  var must = getCouponMin(cp);
  if (cp && must > 0 && subtotal < must) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
    toast('Diskon dibatalkan: subtotal di bawah minimum');
    cp = null;
  }

  var discount = 0;
  if (cp) {
    if (cp.type === 'percent') discount = Math.floor(subtotal * (Number(cp.value) || 0) / 100);
    if (cp.type === 'flat')    discount = Math.min(subtotal, Number(cp.value) || 0);
  }

  var total = Math.max(0, subtotal - discount);
  return { subtotal: subtotal, discount: discount, total: total };
}
export { calcTotalsLocal };

/* =================== Promo ops (BE only) =================== */
export async function applyCoupon(rawCode) {
  var code = String(rawCode || '').trim();
  if (!code) { toast('Masukkan kode promo'); return; }

  var payload = {
    code: code,
    items: (State.cart || []).map(function (c) {
      return { id: c.id, qty: c.qty, price: c.price };
    })
  };

  var res;
  try {
    res = await Api.promoValidate(payload);
  } catch (e) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
    renderCart();
    toast('Gagal menghubungi server promo');
    return;
  }

  var ok = !!(res && (res.ok || res.valid || res.status === 'ok'));
  if (!ok) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
    renderCart();
    toast((res && res.error) || 'Kode promo tidak valid');
    return;
  }

  var data  = res.data || res;
  var type  = String(data.type || '').toLowerCase();
  var value = Number(data.value || 0);
  var min1  = digitsToNumber(data.min_subtotal || data.min_total || data.minimum || data.min || data.minimum_amount || data.min_order || data.min_belanja);
  var min2  = deepPickMin(data);
  var min   = Math.max(min1, min2, 0);

  if (!type || !(value > 0)) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
    renderCart();
    toast('Respon promo tidak valid');
    return;
  }

  State.coupon = { code: code.toUpperCase(), type: type, value: value, min: min };
  if (typeof togglePromoControls === 'function') togglePromoControls();

  // revalidate cepat + render
  revalidateCouponIfNeeded(true);
  renderCart();
  toast('Kode promo diterapkan');
}

export function clearCoupon() {
  if (!State.coupon) return;
  State.coupon = null;
  if (typeof togglePromoControls === 'function') togglePromoControls();
  Store.save();
  renderCart();
  toast('Kode promo dihapus');
}

/* =================== Core ops =================== */
export function addToCart(id, name, price, qty) {
  if (qty == null) qty = 1;
  qty = clampInt(qty, 1);

  var stok = clampInt(getStock(id), 0);
  if (stok <= 0) { toast('Stok habis'); return; }

  var exist = (State.cart || []).find(function (c) { return c.id === id; });
  var already = exist ? exist.qty : 0;
  var remaining = stok - already;

  if (remaining <= 0) { toast('Stok tidak cukup (tersisa 0)'); return; }

  var addQty = Math.min(qty, remaining);
  if (exist) {
    exist.qty += addQty;
  } else {
    State.cart.push({ id: id, name: name, price: Number(price || 0), qty: addQty });
  }

  Store.save();
  revalidateCouponIfNeeded(true); // <<< percepat
  renderCart();

  if (addQty < qty) toast('Stok tidak cukup. Ditambahkan ' + addQty + ' (sisa ' + (stok - (already + addQty)) + ')');
  else toast('Ditambahkan ke keranjang');
}

export function delCartAt(idx) {
  idx = clampInt(idx, 0);
  if (!State.cart || idx >= State.cart.length) return;
  State.cart.splice(idx, 1);

  if (!(State.cart && State.cart.length) && State.coupon) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
  }

  Store.save();
  revalidateCouponIfNeeded(true); // <<< percepat
  renderCart();
}

export function emptyCart() {
  State.cart = [];
  if (State.coupon) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
  }
  Store.save();
  revalidateCouponIfNeeded(true); // <<< percepat
  renderCart();
}

export function setCartQtyAt(idx, newQty) {
  idx = clampInt(idx, 0);
  var c = State.cart && State.cart[idx]; if (!c) return;

  var stok = clampInt(getStock(c.id), 0);
  var v = clampInt(newQty, 1, Math.max(0, stok));

  if (v !== c.qty) {
    c.qty = v;
    Store.save();
    revalidateCouponIfNeeded(true); // <<< percepat
    renderCart();
  }
  if (v < newQty) toast('Melebihi stok tersedia');
}

/* =================== Render Cart UI =================== */
export function renderCart() {
  if (!(State.cart && State.cart.length) && State.coupon) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
  }

  var totals = calcTotalsLocal();
  var subtotal = totals.subtotal, discount = totals.discount, total = totals.total;
  var hasDisc = discount > 0;

  // Ongkir dari State.shipping (diisi oleh shipping.js). Jika keranjang kosong, abaikan ongkir.
  var shipping = (State.cart && State.cart.length) ? Number((State.shipping && State.shipping.fee) || 0) : 0;
  var grand = total + shipping;

  // Totals (ID-based)
  setMoneyText(byId('cartSubtotal'),       subtotal, hasDisc);
  setMoneyText(byId('cartSubtotalMobile'), subtotal, hasDisc);

  // Sembunyikan baris diskon jika tidak ada promo
  var discIdEl = byId('cartDiscount');
  if (discIdEl) {
    var discRow = discIdEl.closest ? discIdEl.closest('.row') : null;
    if (discRow) discRow.hidden = !hasDisc;
  }
  setText('cartDiscount', hasDisc ? ('-' + money(discount)) : '');

  // total akhir pakai grand (total + ongkir)
  setText('cartTotal',   money(grand));
  setText('mobileTotal', money(grand));

  // Catatan total: tampil hanya jika ada promo; tambah "+ ongkir" hanya jika ongkir > 0
  var note = hasDisc ? ('Setelah diskon' + (shipping > 0 ? ' + ongkir' : '')) : '';
  setText('cartTotalNote', note);
  setText('cartTotalNoteMobile', note);
  var n1 = byId('cartTotalNote');       if (n1) n1.hidden = !note;
  var n2 = byId('cartTotalNoteMobile'); if (n2) n2.hidden = !note;

  // Totals (data-* hooks)
  var els;
  els = document.querySelectorAll('[data-cart-subtotal]');
  for (var i=0;i<els.length;i++){
    els[i].innerHTML = hasDisc ? ('<s>' + money(subtotal) + '</s>') : money(subtotal);
  }
  els = document.querySelectorAll('[data-cart-discount]');
  for (var j=0;j<els.length;j++){
    var r = els[j].closest ? els[j].closest('.row') : null;
    if (!hasDisc){
      if (r) r.hidden = true;
      els[j].textContent = '';
    } else {
      if (r) r.hidden = false;
      els[j].textContent = '-' + money(discount);
    }
  }
  els = document.querySelectorAll('[data-cart-shipping]');
  for (var k=0;k<els.length;k++){
    els[k].textContent = money(shipping);
  }
  els = document.querySelectorAll('[data-cart-total]');
  for (var m=0;m<els.length;m++){
    els[m].textContent = money(grand);
  }

  // juga update #cartShipping kalau shipping.js menyuntikkan elemen ini
  var idShip = byId('cartShipping');
  if (idShip) idShip.textContent = money(shipping);

  // Promo controls state
  if (typeof togglePromoControls === 'function') togglePromoControls();

  // Badge & checkout buttons
  var count = (State.cart || []).reduce(function (s, c) { return s + c.qty; }, 0);
  updateCartBadges(count);
  ['btnCheckout', 'btnCheckoutBar', 'btnCheckoutMobile'].forEach(function(id){
    setDisabled(id, !(State.cart && State.cart.length));
  });

  // Promo pill (opsional)
  var pill = byId('promoApplied');
  if (pill) {
    if (State.coupon) {
      var label = State.coupon.type === 'percent'
        ? (String(State.coupon.value) + '%')
        : money(State.coupon.value);
      pill.hidden = false;
      pill.textContent = State.coupon.code + ' • ' + label + ' diterapkan (klik untuk hapus)';
    } else {
      pill.hidden = true;
      pill.textContent = '';
    }
  }

  // Rows
  var tpl = byId('tpl-cart-item');

  function renderInto(box) {
    if (!box || !tpl) return;
    if (!State.cart || !State.cart.length) { box.innerHTML = '<div class="muted">Belum ada item.</div>'; return; }

    box.innerHTML = '';
    for (var i=0;i<State.cart.length;i++){
      (function(iIdx){
        var c = State.cart[iIdx];
        var row = tpl.content.firstElementChild.cloneNode(true);

        var stok = clampInt(getStock(c.id), 0);
        var safeQty = Math.min(c.qty, Math.max(0, stok));
        var over = c.qty > stok;

        var nameEl = row.querySelector('.cart__name');
        if (nameEl) nameEl.textContent = c.name + (stok <= 0 ? ' (Habis)' : '');

        var qtyCell = row.querySelector('.cart__qty');
        if (qtyCell) {
          qtyCell.innerHTML =
            '<div class="qtyctl" data-idx="' + iIdx + '">' +
            '  <button type="button" class="qdec" aria-label="Kurangi">–</button>' +
            '  <input class="qinput" type="number" min="1" step="1" value="' + safeQty + '">' +
            '  <button type="button" class="qinc" aria-label="Tambah">+</button>' +
            '</div>';

          var wrap = qtyCell.querySelector('.qtyctl');
          var dec = wrap ? wrap.querySelector('.qdec') : null;
          var inc = wrap ? wrap.querySelector('.qinc') : null;
          var inp = wrap ? wrap.querySelector('.qinput') : null;

          if (dec) dec.addEventListener('click', function(){ setCartQtyAt(iIdx, safeQty - 1); });
          if (inc) inc.addEventListener('click', function(){ setCartQtyAt(iIdx, safeQty + 1); });
          if (inp) inp.addEventListener('input', function(){
            var v = clampInt(inp.value, 1);
            if (stok > 0 && v > stok) { v = stok; toast('Melebihi stok tersedia'); }
            setCartQtyAt(iIdx, v);
          });
        }

        var subEl = row.querySelector('.cart__sub');
        if (subEl) subEl.textContent = money(safeQty * Number(c.price || 0));

        if (over) {
          row.classList.add('warn');
          row.title = 'Melebihi stok. Stok tersedia: ' + stok;
        }

        var delBtn = row.querySelector('.cart__del');
        if (delBtn){
          if (delBtn.addEventListener) delBtn.addEventListener('click', function(){ delCartAt(iIdx); });
          else delBtn.onclick = function(){ delCartAt(iIdx); };
        }

        box.appendChild(row);
      })(i);
    }
  }

  renderInto(byId('cartItems'));        // desktop
  renderInto(byId('cartItemsMobile'));  // mobile

  // Re-validate promo tiap render (tetap didebounce, kecil)
  revalidateCouponIfNeeded();
}

/* =================== Promo revalidate (debounced / immediate) =================== */
var _promoKey = '';
var _promoTO  = null;

function _makePromoKey(){
  if (!State.coupon) return '';
  var items = (State.cart || []).map(function(c){
    return c.id + ':' + c.qty + ':' + c.price;
  }).join(',');
  return State.coupon.code + '|' + items;
}

/**
 * Revalidate kupon ke server.
 * @param {boolean} immediate - jika true, langsung panggil tanpa debounce
 */
function revalidateCouponIfNeeded(immediate){
  if (!State.coupon) { _promoKey = ''; return; }

  // Jika sudah dicopot oleh local min-check, jangan lanjut.
  if (!State.coupon) return;

  var key = _makePromoKey();
  if (!immediate && key === _promoKey) return;
  _promoKey = key;

  if (_promoTO) { try{ clearTimeout(_promoTO); }catch(_){} }

  var fire = function(){
    // Jika kupon sudah hilang saat menunggu, batalkan
    if (!State.coupon) return;

    var payload = {
      code: State.coupon.code,
      items: (State.cart || []).map(function(c){ return { id:c.id, qty:c.qty, price:c.price }; })
    };

    Api.promoValidate(payload).then(function(res){
      var ok = !!(res && (res.ok || res.valid || res.status === 'ok'));
      if (!ok){
        State.coupon = null;
        if (typeof togglePromoControls === 'function') togglePromoControls();
        renderCart();
        toast('Diskon dibatalkan: tidak lagi memenuhi syarat');
        return;
      }

      var data = res.data || res;
      var t = String(data.type || '').toLowerCase();
      var v = Number(data.value || 0);
      var min1 = digitsToNumber(data.min_subtotal || data.min_total || data.minimum || data.min || data.minimum_amount || data.min_order || data.min_belanja);
      var min2 = deepPickMin(data);
      var min = Math.max(min1, min2, 0);

      if (!t || !(v > 0)){
        State.coupon = null;
        if (typeof togglePromoControls === 'function') togglePromoControls();
        renderCart();
        toast('Diskon dibatalkan: respon tidak valid');
        return;
      }
      // update value & minimum (bila berubah)
      State.coupon = { code: State.coupon.code, type: t, value: v, min: min };

      // Kalau setelah update ternyata subtotal < min, copot instan.
      var subNow = (State.cart || []).reduce(function (s, c) {
        return s + (Number(c.qty || 0) * Number(c.price || 0));
      }, 0);
      if (min > 0 && subNow < min){
        State.coupon = null;
        if (typeof togglePromoControls === 'function') togglePromoControls();
        renderCart();
        toast('Diskon dibatalkan: subtotal di bawah minimum');
      }
    }).catch(function(){ /* network error: abaikan, biar tidak nge-spam */});
  };

  if (immediate) fire();
  else _promoTO = setTimeout(fire, 80); // debounce kecil biar responsif
}

/* =================== Stock guard =================== */
export function validateCartAgainstStock() {
  var changed = false;
  var newCart = [];

  for (var i=0;i<(State.cart || []).length;i++){
    var c = State.cart[i];
    var stok = clampInt(getStock(c.id), 0);
    if (!stok || stok <= 0) { changed = true; continue; }
    if (c.qty > stok) { c.qty = stok; changed = true; }
    newCart.push(c);
  }

  if (changed) {
    State.cart = newCart;
    Store.save();
    revalidateCouponIfNeeded(true);
    renderCart();
    toast('Keranjang disesuaikan dengan stok yang tersedia');
  }
}
