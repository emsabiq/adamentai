'use strict';
// Product detail modal: opsi (radio), add-on (checkbox + stepper per unit), qty utama, tombol "Tambah"

import { byId, money, toast } from './utils.js';
import { getItemById } from './state.js';
import { addToCart } from './cart.js';

/* =======================
 * Helpers (coercers)
 * ======================= */
function num(n){ const x = Number(n); return Number.isFinite(x) ? x : 0; }
function int(n){ const x = parseInt(n, 10); return Number.isFinite(x) ? x : 0; }
function txt(s){ return String(s == null ? '' : s); }

/* =======================
 * Extractors (fleksibel utk berbagai skema)
 * ======================= */
function extractOptions(item){
  let src = item.options ?? item.opts ?? item.variants ?? item.levels ?? item.pilihan ?? item.opsi ?? [];
  if (!Array.isArray(src)) src = [];
  const out = [];
  for (let i=0;i<src.length;i++){
    const o = src[i] || {};
    const key = (o.key ?? o.id ?? o.value ?? o.label ?? ('opt'+(i+1))).toString();
    const label = txt(o.label ?? o.name ?? o.title ?? key);
    const pd = num(o.price_delta ?? o.priceDelta ?? o.delta ?? o.plus ?? 0);
    out.push({ key, label, price_delta: pd });
  }
  return out;
}

function extractAddons(item){
  let src = item.addons ?? item.add_ons ?? item.extras ?? item.toppings ?? item.additional ?? item.tambahan ?? [];
  if (!Array.isArray(src)) src = [];
  const out = [];
  for (let i=0;i<src.length;i++){
    const a = src[i] || {};
    const id = a.id ?? a.code ?? a.key ?? (a.name || a.label || ('addon'+(i+1)));
    const name = txt(a.name ?? a.label ?? a.title ?? ('Addon '+(i+1)));
    const price = num(a.price ?? a.harga ?? a.cost ?? 0);
    const max = (a.max != null) ? int(a.max) : null; // batas qty per unit (opsional)
    out.push({ id, name, price, max });
  }
  return out;
}

/* =======================
 * Public: apakah produk punya pilihan?
 * ======================= */
export function productHasChoices(item){
  return extractOptions(item).length > 0 || extractAddons(item).length > 0;
}

/* =======================
 * Template helpers
 * ======================= */
function getTpl(){ return byId('tpl-product'); }
function fmtDelta(pd){ return pd ? (pd > 0 ? ` (+${money(pd)})` : ` (${money(pd)})`) : ''; }

/* =======================
 * Build controls
 * ======================= */
function buildOptionRadios(host, opts){
  host.innerHTML = '';
  const group = 'p_opt_' + Math.random().toString(36).slice(2,7);
  opts.forEach((o, i) => {
    const row = document.createElement('label');
    row.className = 'opt-row';
    row.innerHTML = `
      <input type="radio" name="${group}" value="${encodeURIComponent(o.key)}" ${i===0?'checked':''}>
      <span class="opt-label">${txt(o.label)}${fmtDelta(o.price_delta)}</span>
    `;
    host.appendChild(row);
  });
}

function buildAddonRows(host, addons, onChange){
  host.innerHTML = '';
  addons.forEach((a, idx) => {
    const row = document.createElement('div');
    row.className = 'addon-row';
    row.innerHTML = `
      <label class="addon-left">
        <input type="checkbox" class="ad_chk">
        <span class="ad_name">${txt(a.name)}</span>
        <span class="ad_price">+${money(a.price)}</span>
      </label>
      <div class="ad_qty">
        <button type="button" class="ad_dec" aria-label="Kurangi">–</button>
        <input type="number" class="ad_input" min="0" step="1" value="1" disabled>
        <button type="button" class="ad_inc" aria-label="Tambah">+</button>
      </div>
    `;
    host.appendChild(row);

    const chk = row.querySelector('.ad_chk');
    const dec = row.querySelector('.ad_dec');
    const inc = row.querySelector('.ad_inc');
    const inp = row.querySelector('.ad_input');

    function setQty(v){
      let vv = Math.max(0, int(v));
      if (a.max != null) vv = Math.min(vv, a.max);
      inp.value = String(vv);
    }

    chk.addEventListener('change', () => {
      const on = chk.checked;
      inp.disabled = !on;
      if (on && int(inp.value) <= 0) inp.value = '1';
      onChange && onChange();
    });
    dec.addEventListener('click', () => {
      setQty(int(inp.value) - 1);
      if (int(inp.value) <= 0) { chk.checked = false; inp.disabled = true; }
      onChange && onChange();
    });
    inc.addEventListener('click', () => {
      chk.checked = true; inp.disabled = false;
      setQty(int(inp.value) + 1);
      onChange && onChange();
    });
    inp.addEventListener('input', () => {
      setQty(inp.value);
      if (int(inp.value) <= 0){ chk.checked = false; inp.disabled = true; }
      onChange && onChange();
    });
  });
}

/* =======================
 * Modal open/close
 * ======================= */
function closeModal(overlay){
  try{ overlay.remove(); }catch(_){}
  try{ document.body.classList.remove('modal-open'); }catch(_){}
}

function bindEscToClose(overlay){
  function onKey(e){
    if (e.key === 'Escape'){
      e.preventDefault();
      window.removeEventListener('keydown', onKey);
      closeModal(overlay);
    }
  }
  window.addEventListener('keydown', onKey);
}

/* =======================
 * Main: open modal
 * ======================= */
export function openProductModal(itemOrId){
  const item = (typeof itemOrId === 'object') ? itemOrId : getItemById(itemOrId);
  if (!item){ toast('Produk tidak ditemukan'); return; }

  const tpl = getTpl();
  if (!tpl || !tpl.content){ toast('Template produk tidak tersedia'); return; }

  // Clone template
  const overlay = tpl.content.firstElementChild.cloneNode(true);
  const modal   = overlay.querySelector('.pmodal');

  // Elements
  const nameEl  = overlay.querySelector('[data-pname]');
  const priceEl = overlay.querySelector('[data-pprice]');
  const stockEl = overlay.querySelector('[data-stock]');
  const optsBox = overlay.querySelector('[data-opts]');
  const optsHost= optsBox ? optsBox.querySelector('.opts-host') : null;
  const adBox   = overlay.querySelector('[data-addons]');
  const adHost  = adBox ? adBox.querySelector('.addons-host') : null;
  const qtyInp  = overlay.querySelector('[data-qty]');
  const qtyDec  = overlay.querySelector('[data-qty-dec]');
  const qtyInc  = overlay.querySelector('[data-qty-inc]');
  const prevEl  = overlay.querySelector('[data-preview]');
  const okBtn   = overlay.querySelector('[data-ok]');
  const cancel  = overlay.querySelector('[data-cancel]');

  // Data
  const basePrice = num(item.price || 0);
  const options   = extractOptions(item);
  const addons    = extractAddons(item);

  // Fill header
  if (nameEl)  nameEl.textContent  = txt(item.name || item.title || '');
  if (priceEl) priceEl.textContent = money(basePrice);

  // (opsional) tampilkan stok jika ada di item
  const showStock = (item.stock != null);
  if (stockEl){
    if (showStock){
      const s = int(item.stock);
      stockEl.textContent = `(Stok: ${s})`;
      stockEl.hidden = false;
    } else {
      stockEl.hidden = true;
    }
  }

  // Options
  if (options.length && optsBox && optsHost){
    optsBox.hidden = false;
    buildOptionRadios(optsHost, options);
  } else if (optsBox){
    optsBox.hidden = true;
  }

  // Addons
  if (addons.length && adBox && adHost){
    adBox.hidden = false;
    buildAddonRows(adHost, addons, updatePreview);
  } else if (adBox){
    adBox.hidden = true;
  }

  // Qty main
  if (qtyInp){
    qtyInp.value = '1';
    qtyInp.min = '1';
    qtyInp.step = '1';
    qtyInp.addEventListener('input', () => {
      let v = Math.max(1, int(qtyInp.value || 1));
      // clamp dengan stok bila ada
      if (showStock) v = Math.min(v, Math.max(1, int(item.stock)));
      qtyInp.value = String(v);
      updatePreview();
    });
  }
  if (qtyDec) qtyDec.addEventListener('click', () => {
    if (!qtyInp) return;
    let v = Math.max(1, int(qtyInp.value || 1) - 1);
    qtyInp.value = String(v);
    updatePreview();
  });
  if (qtyInc) qtyInc.addEventListener('click', () => {
    if (!qtyInp) return;
    let v = Math.max(1, int(qtyInp.value || 1) + 1);
    if (showStock) v = Math.min(v, Math.max(1, int(item.stock)));
    qtyInp.value = String(v);
    updatePreview();
  });

  // Read selection
  function readSelection(){
    // option terpilih
    let opt = null, optDelta = 0;
    if (options.length && optsHost && !optsBox.hidden){
      const r = optsHost.querySelector('input[type="radio"]:checked');
      if (r){
        const key = decodeURIComponent(r.value || '');
        const found = options.find(o => String(o.key) === String(key));
        if (found){
          opt = { key: found.key, label: found.label, price_delta: num(found.price_delta || 0) };
          optDelta = opt.price_delta;
        }
      }
    }
    // addons terpilih (qty per UNIT item utama)
    const adSel = [];
    if (addons.length && adHost && !adBox.hidden){
      const rows = adHost.querySelectorAll('.addon-row');
      rows.forEach((row, i) => {
        const chk = row.querySelector('.ad_chk');
        const inp = row.querySelector('.ad_input');
        if (chk && chk.checked){
          const a = addons[i];
          const q = Math.max(0, int(inp && inp.value || 0));
          if (q > 0){
            adSel.push({ id: a.id, name: a.name, price: a.price, qty: q });
          }
        }
      });
    }
    const qty = Math.max(1, int(qtyInp && qtyInp.value || 1));
    return { opt, optDelta, addons: adSel, qty };
  }

  // Preview total
  function updatePreview(){
    const sel = readSelection();
    const perUnit = basePrice
      + sel.optDelta
      + sel.addons.reduce((s,a) => s + num(a.price) * int(a.qty), 0);
    const total = perUnit * sel.qty;

    if (prevEl){
      prevEl.innerHTML =
        `Per unit: <strong>${money(perUnit)}</strong> &nbsp;•&nbsp; Total: <strong>${money(total)}</strong>`;
    }
  }

  // Submit handler
  if (okBtn){
    okBtn.addEventListener('click', () => {
      const sel = readSelection();
      // Kirim ke cart:
      // addToCart(id, name, basePrice, qty, opt?, addons?),
      // kompatibel backward (argumen ekstra akan diabaikan jika versi lama)
      addToCart(
        item.id,
        txt(item.name || item.title || ''),
        num(item.price || 0),
        sel.qty,
        sel.opt || null,
        sel.addons || []
      );
      toast('Ditambahkan ke keranjang');
      closeModal(overlay);
    });
  }

  if (cancel) cancel.addEventListener('click', () => closeModal(overlay));
  // Klik di luar modal => tutup
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
  bindEscToClose(overlay);

  // Mount
  document.body.appendChild(overlay);
  document.body.classList.add('modal-open');

  // Render awal
  updatePreview();
}
