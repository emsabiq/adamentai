'use strict';
// Cart module: tambah/hapus item, render ringkasan & baris, validasi stok + promo (ES2019-safe)

import { byId, setText, setDisabled, updateCartBadges, toast, money } from './utils.js';
import { State, Store, getStock, calcTotals, normalizeCartItem, buildCartKey, computeLineTotals } from './state.js';
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
function sumQtyById(id, exceptIdx){
  var sid = String(id);
  var total = 0;
  var arr = State.cart || [];
  for (var i=0;i<arr.length;i++){
    if (i === exceptIdx) continue;
    if (String(arr[i].id) === sid) total += clampInt(arr[i].qty, 0);
  }
  return total;
}

/* ===== Shipping lock helper (hindari import silang) ===== */
function shippingCheckoutLocked(){
  try{
    var s = State && State.shipping ? State.shipping : {};
    var mode = s && s.mode ? s.mode : 'delivery';
    if (mode === 'pickup') return false;
    if (!s || !s.dest) return true;
    if (s._quoting) return true;
    if (!s.quote) return true;
    if (s.quote && s.quote.deliverable === false) return true;
    var feeNum = Number(s.fee);
    if (!isFinite(feeNum) || feeNum < 0) return true;
    return false;
  }catch(_){ return false; }
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

/* =================== Hitung totals (pakai state.calcTotals) =================== */
/** Kompatibilitas ke pemanggil lama: tetap diekspor */
function calcTotalsLocal() {
  // subtotal/discount/total sudah memperhitungkan opt.price_delta dan addons
  var totals = calcTotals();
  var subtotal = totals.subtotal;

  // Validasi minimum kupon pakai subtotal baru
  var cp = State.coupon;
  var must = getCouponMin(cp);
  if (cp && must > 0 && subtotal < must) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
    toast('Diskon dibatalkan: subtotal di bawah minimum');
    cp = null;
  }

  // Diskon direkalkulasi sesuai kupon aktif
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

  // Payload minimal (id, qty, price) — flatten add-on akan ditangani di checkout.js
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
/**
 * addToCart dengan dukungan opsi & add-on.
 * - Tetap backward compatible: pemanggilan lama tanpa opt/addons tetap jalan.
 * - Merging berdasarkan buildCartKey(id, opt, addons).
 */
export function addToCart(id, name, price, qty, opt, addons) {
  if (qty == null) qty = 1;
  qty = clampInt(qty, 1);

  var stok = clampInt(getStock(id), 0);
  if (stok <= 0) { toast('Stok habis'); return; }

  // Normalisasi calon item
  var candidate = normalizeCartItem({ id:id, name:name, price:price, qty:qty, opt:opt, addons:addons });
  var keyCand  = buildCartKey(candidate.id, candidate.opt, candidate.addons);

  // Hitung sisa stok berdasar total qty semua baris dengan id yang sama
  var alreadyAll = sumQtyById(id, -1); // -1 artinya tidak mengecualikan apa pun (penjumlahan semua)
  var remaining = Math.max(0, stok - alreadyAll);
  if (remaining <= 0) { toast('Stok tidak cukup (tersisa 0)'); return; }

  var addQty = Math.min(candidate.qty, remaining);
  if (addQty <= 0) { toast('Stok tidak cukup'); return; }
  candidate.qty = addQty;

  // Coba merge ke baris yang sama (key sama)
  var merged = false;
  for (var i=0;i<(State.cart || []).length;i++){
    var it = normalizeCartItem(State.cart[i]);
    var keyExist = buildCartKey(it.id, it.opt, it.addons);
    if (keyExist === keyCand){
      it.qty = clampInt(it.qty, 1) + addQty;
      State.cart[i] = it;
      merged = true;
      break;
    }
  }
  if (!merged){
    State.cart.push(candidate);
  }

  Store.save();
  revalidateCouponIfNeeded(true);
  renderCart();

  if (addQty < qty) toast('Stok tidak cukup. Ditambahkan ' + addQty + ' (sisa ' + (stok - (alreadyAll + addQty)) + ')');
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
  revalidateCouponIfNeeded(true);
  renderCart();
}

export function emptyCart() {
  State.cart = [];
  if (State.coupon) {
    State.coupon = null;
    if (typeof togglePromoControls === 'function') togglePromoControls();
  }
  Store.save();
  revalidateCouponIfNeeded(true);
  renderCart();
}

export function setCartQtyAt(idx, newQty) {
  idx = clampInt(idx, 0);
  var c = State.cart && State.cart[idx]; if (!c) return;

  var stok = clampInt(getStock(c.id), 0);
  // Hitung sisa yang boleh untuk baris ini (kurangi qty baris lain dengan id sama)
  var others = sumQtyById(c.id, idx);
  var allowedForThis = Math.max(0, stok - others);

  var v = clampInt(newQty, 1, allowedForThis);

  if (v !== c.qty) {
    c.qty = v;
    State.cart[idx] = normalizeCartItem(c); // konsistenkan skema
    Store.save();
    revalidateCouponIfNeeded(true);
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

  var shipping = (State.cart && State.cart.length) ? Number((State.shipping && State.shipping.fee) || 0) : 0;
  var grand = total + shipping;

  setMoneyText(byId('cartSubtotal'),       subtotal, hasDisc);
  setMoneyText(byId('cartSubtotalMobile'), subtotal, hasDisc);

  var discIdEl = byId('cartDiscount');
  if (discIdEl) {
    var discRow = discIdEl.closest ? discIdEl.closest('.row') : null;
    if (discRow) discRow.hidden = !hasDisc;
  }
  setText('cartDiscount', hasDisc ? ('-' + money(discount)) : '');

  setText('cartTotal',   money(grand));
  setText('mobileTotal', money(grand));

  var note = hasDisc ? ('Setelah diskon' + (shipping > 0 ? ' + ongkir' : '')) : '';
  setText('cartTotalNote', note);
  setText('cartTotalNoteMobile', note);
  var n1 = byId('cartTotalNote');       if (n1) n1.hidden = !note;
  var n2 = byId('cartTotalNoteMobile'); if (n2) n2.hidden = !note;

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

  var idShip = byId('cartShipping');
  if (idShip) idShip.textContent = money(shipping);

  if (typeof togglePromoControls === 'function') togglePromoControls();

  var count = (State.cart || []).reduce(function (s, c) { return s + clampInt(c.qty, 0); }, 0);
  updateCartBadges(count);

  // ⛔ Jangan enable tombol kalau shipping lock masih aktif
  var lock = shippingCheckoutLocked();
  ['btnCheckout', 'btnCheckoutBar', 'btnCheckoutMobile'].forEach(function(id){
    setDisabled(id, !(State.cart && State.cart.length) || lock);
  });

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

  var tpl = byId('tpl-cart-item');

  function renderInto(box) {
    if (!box || !tpl) return;
    if (!State.cart || !State.cart.length) { box.innerHTML = '<div class="muted">Belum ada item.</div>'; return; }

    box.innerHTML = '';
    for (var i2=0;i2<State.cart.length;i2++){
      (function(iIdx){
        var c = normalizeCartItem(State.cart[i2]); // pastikan normal
        var row = tpl.content.firstElementChild.cloneNode(true);

        var stok = clampInt(getStock(c.id), 0);
        // sisa untuk baris ini = stok - qty baris lain (id yang sama)
        var allowedForThis = Math.max(0, stok - sumQtyById(c.id, i2));
        var safeQty = Math.min(c.qty, Math.max(0, allowedForThis));
        var over = c.qty > allowedForThis;

        // Nama + meta (opsi dan add-on)
        var nameEl = row.querySelector('.cart__name');
        if (nameEl) nameEl.textContent = c.name + (stok <= 0 ? ' (Habis)' : '');

        // sisipkan meta (opsi + addons)
        var metaHost = row.querySelector('.cart__meta');
        if (!metaHost){
          // jika template tidak sediakan, tambahkan di bawah nama
          if (nameEl && nameEl.parentElement){
            metaHost = document.createElement('div');
            metaHost.className = 'cart__meta';
            metaHost.style.fontSize = '12px';
            metaHost.style.opacity = '0.9';
            metaHost.style.marginTop = '2px';
            nameEl.parentElement.insertBefore(metaHost, nameEl.nextSibling);
          }
        }
        if (metaHost){
          var bits = [];
          if (c.opt){
            var pd = (c.opt.price_delta != null) ? Number(c.opt.price_delta) : 0;
            var optTxt = 'Opsi: ' + (c.opt.label || c.opt.key || '');
            if (pd > 0) optTxt += ' (+' + money(pd) + ')';
            if (pd < 0) optTxt += ' (' + money(pd) + ')';
            bits.push(optTxt);
          }
          if (c.addons && c.addons.length){
            var addStrs = [];
            for (var ai=0; ai<c.addons.length; ai++){
              var a = c.addons[ai];
              addStrs.push(a.name + ' +' + money(a.price) + ' ×' + clampInt(a.qty,0));
            }
            bits.push('Add-on: ' + addStrs.join(', '));
          }
          metaHost.textContent = bits.join(' • ');
          if (!bits.length) metaHost.textContent = '';
        }

        // Qty controls
        var qtyCell = row.querySelector('.cart__qty');
        if (qtyCell) {
          qtyCell.innerHTML =
            '<div class="qtyctl" data-idx="' + iIdx + '">'+
            '  <button type="button" class="qdec" aria-label="Kurangi">–</button>'+
            '  <input class="qinput" type="number" min="1" step="1" value="' + (safeQty || 1) + '">'+
            '  <button type="button" class="qinc" aria-label="Tambah">+</button>'+
            '</div>';

          var wrap = qtyCell.querySelector('.qtyctl');
          var dec = wrap ? wrap.querySelector('.qdec') : null;
          var inc = wrap ? wrap.querySelector('.qinc') : null;
          var inp = wrap ? wrap.querySelector('.qinput') : null;

          if (dec) dec.addEventListener('click', function(){ setCartQtyAt(iIdx, clampInt((safeQty || 1) - 1, 1)); });
          if (inc) inc.addEventListener('click', function(){ setCartQtyAt(iIdx, (safeQty || 1) + 1); });
          if (inp) inp.addEventListener('input', function(){
            var v = clampInt(inp.value, 1);
            var allow = Math.max(0, getStock(c.id) - sumQtyById(c.id, iIdx));
            if (allow > 0 && v > allow) { v = allow; toast('Melebihi stok tersedia'); }
            setCartQtyAt(iIdx, v);
          });
        }

        // Subtotal baris (termasuk opt delta & addons)
        var subEl = row.querySelector('.cart__sub');
        if (subEl) {
          var tmp = _clone(c);
          tmp.qty = safeQty || 1;
          var t = computeLineTotals(tmp);
          subEl.textContent = money(t.line_subtotal);
        }

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
      })(i2);
    }
  }

  renderInto(byId('cartItems'));
  renderInto(byId('cartItemsMobile'));

  revalidateCouponIfNeeded();
}

/* =================== Promo revalidate (debounced / immediate) =================== */
var _promoKey = '';
var _promoTO  = null;

function _makePromoKey(){
  if (!State.coupon) return '';
  // masukkan item id:qty:price saja (payload API tetap sama)
  var items = (State.cart || []).map(function(c){
    return c.id + ':' + c.qty + ':' + c.price;
  }).join(',');
  return State.coupon.code + '|' + items;
}

function revalidateCouponIfNeeded(immediate){
  if (!State.coupon) { _promoKey = ''; return; }
  if (!State.coupon) return;

  var key = _makePromoKey();
  if (!immediate && key === _promoKey) return;
  _promoKey = key;

  if (_promoTO) { try{ clearTimeout(_promoTO); }catch(_){} }

  var fire = function(){
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
      State.coupon = { code: State.coupon.code, type: t, value: v, min: min };

      // Pakai subtotal komprehensif (opsi+addon)
      var subNow = calcTotals().subtotal;
      if (min > 0 && subNow < min){
        State.coupon = null;
        if (typeof togglePromoControls === 'function') togglePromoControls();
        renderCart();
        toast('Diskon dibatalkan: subtotal di bawah minimum');
      }
    }).catch(function(){});
  };

  if (immediate) fire();
  else _promoTO = setTimeout(fire, 80);
}

/* =================== Stock guard =================== */
export function validateCartAgainstStock() {
  // Sesuaikan qty agar total per-ID tidak melebihi stok
  var arr = State.cart || [];
  var byId = Object.create(null);
  var changed = false;

  // Hitung stok dan distribusi qty per baris secara urut
  for (var i=0;i<arr.length;i++){
    var c = normalizeCartItem(arr[i]);
    var id = String(c.id);
    var stok = clampInt(getStock(id), 0);
    if (!byId[id]) byId[id] = { used:0, stock:stok };

    var left = Math.max(0, byId[id].stock - byId[id].used);
    var want = clampInt(c.qty, 0);
    var take = Math.min(want, left);

    if (take !== want) changed = true;
    c.qty = take;

    byId[id].used += take;
    arr[i] = c;
  }

  // Drop baris yang qty=0
  var newCart = [];
  for (var j=0;j<arr.length;j++){
    if (clampInt(arr[j].qty,0) > 0) newCart.push(arr[j]);
    else changed = true;
  }

  if (changed) {
    State.cart = newCart;
    Store.save();
    revalidateCouponIfNeeded(true);
    renderCart();
    toast('Keranjang disesuaikan dengan stok yang tersedia');
  }
}

/* ===== util kecil lokal ===== */
function _clone(o){ return JSON.parse(JSON.stringify(o || {})); }
