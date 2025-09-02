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

/* =================== Hitung totals (perhitungkan coupon) =================== */
function calcTotalsLocal() {
  var subtotal = (State.cart || []).reduce(function (s, c) {
    return s + (Number(c.qty || 0) * Number(c.price || 0));
  }, 0);

  var discount = 0;
  var cp = State.coupon;
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

  if (!type || !(value > 0)) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
    renderCart();
    toast('Respon promo tidak valid');
    return;
  }

  State.coupon = { code: code.toUpperCase(), type: type, value: value };
  if (typeof togglePromoControls === 'function') togglePromoControls();
  renderCart();
  toast('Kode promo diterapkan');
}

export function clearCoupon() {
  if (!State.coupon) return;
  State.coupon = null;
  if (typeof togglePromoControls === 'function') togglePromoControls();
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
  renderCart();

  if (addQty < qty) toast('Stok tidak cukup. Ditambahkan ' + addQty + ' (sisa ' + (stok - (already + addQty)) + ')');
  else toast('Ditambahkan ke keranjang');
}

export function delCartAt(idx) {
  idx = clampInt(idx, 0);
  if (!State.cart || idx >= State.cart.length) return;
  State.cart.splice(idx, 1);
  Store.save();
  renderCart();
}

export function emptyCart() {
  State.cart = [];
  Store.save();
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
    renderCart();
  }
  if (v < newQty) toast('Melebihi stok tersedia');
}

/* =================== Render Cart UI =================== */
export function renderCart() {
  var totals = calcTotalsLocal();
  var subtotal = totals.subtotal, discount = totals.discount, total = totals.total;
  var hasDisc = discount > 0;

  // Ongkir dari State.shipping (diisi oleh shipping.js). Jika keranjang kosong, abaikan ongkir.
  var shipping = (State.cart && State.cart.length) ? Number((State.shipping && State.shipping.fee) || 0) : 0;
  var grand = total + shipping;

  // Totals (ID-based)
  setMoneyText(byId('cartSubtotal'),       subtotal, hasDisc);
  setMoneyText(byId('cartSubtotalMobile'), subtotal, hasDisc);
  setText('cartDiscount', '-' + money(discount));
  // total akhir pakai grand (total + ongkir)
  setText('cartTotal',   money(grand));
  setText('mobileTotal', money(grand));

  // catatan total
  var note = (hasDisc || shipping > 0)
    ? ('Setelah diskon' + (shipping > 0 ? ' + ongkir' : ''))
    : '';
  setText('cartTotalNote', note);
  setText('cartTotalNoteMobile', note);

  // Totals (data-* hooks)
  var els;
  els = document.querySelectorAll('[data-cart-subtotal]');
  for (var i=0;i<els.length;i++){
    els[i].innerHTML = hasDisc ? ('<s>' + money(subtotal) + '</s>') : money(subtotal);
  }
  els = document.querySelectorAll('[data-cart-discount]');
  for (var j=0;j<els.length;j++){
    els[j].textContent = '-' + money(discount);
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
        if (delBtn) delBtn.addEventListener('click', function(){ delCartAt(iIdx); });

        box.appendChild(row);
      })(i);
    }
  }

  renderInto(byId('cartItems'));        // desktop
  renderInto(byId('cartItemsMobile'));  // mobile
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
    renderCart();
    toast('Keranjang disesuaikan dengan stok yang tersedia');
  }
}
