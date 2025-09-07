'use strict';
// Catalog module: chips (kategori), filter + render grid (Best, Strip, Menu), kartu menu

import { byId, money, escapeHTML } from './utils.js';
import { State, BEST_CATEGORY, STRIP_CATEGORY, getStock } from './state.js';
import { CARD_CACHE, IMG_OK_URL, driveUrlCandidates, PLACEHOLDER_IMG } from './images.js';
import { addToCart } from './cart.js';
import { openProductModal, productHasChoices } from './product.js';

/* =============== Helpers =============== */
function formatCatBadge(cat){
  const c = String(cat || '');
  const lc = c.toLowerCase();
  const cls =
    lc === BEST_CATEGORY.toLowerCase()  ? 'badge badge--best'  :
    lc === STRIP_CATEGORY.toLowerCase() ? 'badge badge--strip' :
    lc.includes('promo')                ? 'badge badge--promo' :
                                          'badge';
  return c ? `<span class="${cls}">${escapeHTML(c)}</span>` : '-';
}

/* =============== Chips (kategori) =============== */
function renderChips(){
  const mount = byId('chipsCatMount'); if (!mount) return;
  const chips = [
    `<button class="chip" data-cat="" role="tab" aria-selected="true">Semua</button>`,
    ...State.cats.map(c => `<button class="chip" data-cat="${escapeHTML(c.name)}" role="tab">${escapeHTML(c.name)}</button>`)
  ].join('');
  mount.innerHTML = chips;
  setChipActive(State.selectedCat || '');
}

function setChipActive(catValue){
  State.selectedCat = catValue;
  document.querySelectorAll('.chips-scroll .chip').forEach(chip=>{
    const is = (chip.dataset.cat || '') === (State.selectedCat || '');
    chip.classList.toggle('is-active', is);
    chip.setAttribute('aria-selected', is ? 'true' : 'false');
  });
}

/* =============== Filter items =============== */
function filterItems(){
  const qEl = byId('q');
  const q = (qEl?.value || '').trim().toLowerCase();
  return State.items.filter(m=>{
    if (State.selectedCat && String(m.category||'').toLowerCase() !== State.selectedCat.toLowerCase()) return false;
    if (q && !(String(m.name).toLowerCase().includes(q) || String(m.category||'').toLowerCase().includes(q))) return false;
    return true;
  });
}

/* =============== Kartu menu (dengan cache node & image multi-candidate) =============== */
function createMenuCard(m){
  // Reuse node dari cache bila ada
  let node = CARD_CACHE.get(m.id);
  if (!node){
    const tpl = byId('tpl-card');
    node = tpl ? tpl.content.firstElementChild.cloneNode(true) : document.createElement('article');

    // IMG: setup sekali + resolved-url cache
    const imgEl = node.querySelector('.card__img');
    if (imgEl){
      imgEl.loading = 'lazy';
      imgEl.decoding = 'async';
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.alt = m.name || 'menu';

      const resolved = IMG_OK_URL.get(m.id) || IMG_OK_URL.get(m.image_url);
      if (resolved){
        imgEl.src = resolved;
      } else {
        const candidates = driveUrlCandidates(m.image_url);
        let i = 0;
        function tryNext(){ imgEl.src = candidates[i++] || PLACEHOLDER_IMG; }
        imgEl.addEventListener('load', function onOk(){
          IMG_OK_URL.set(m.id, imgEl.src);
          IMG_OK_URL.set(m.image_url, imgEl.src);
          imgEl.removeEventListener('load', onOk);
        });
        imgEl.onerror = tryNext; tryNext();
      }
    }

    // tombol add & input qty (bind sekali)
    const addBtn = node.querySelector('.add-btn');
    const qtyInput = node.querySelector('.qty');
    if (qtyInput){
      qtyInput.min = 1; qtyInput.step = 1;
      qtyInput.addEventListener('input', ()=> {
        let v = Number(qtyInput.value||1);
        const stok = getStock(m.id);
        if (v < 1) v = 1;
        if (stok > 0 && v > stok) v = stok;
        qtyInput.value = v;
      });
    }
    if (addBtn){
      addBtn.addEventListener('click', ()=> {
        // Jika produk punya opsi/add-on → buka modal detail
        if (productHasChoices(m)) {
          openProductModal(m);
          return;
        }
        // Tidak punya opsi/add-on → langsung add
        const q = Math.max(1, Number((node.querySelector('.qty')?.value) || 1));
        addToCart(m.id, m.name, Number(m.price), q);
      });
    }

    CARD_CACHE.set(m.id, node);
  }

  // Update konten dinamis tiap render
  const imgEl2 = node.querySelector('.card__img');
  if (imgEl2) imgEl2.alt = m.name || 'menu';

  const titleEl = node.querySelector('.card__title');
  if (titleEl) titleEl.textContent = m.name;

  const metaEl = node.querySelector('.card__meta');
  if (metaEl) metaEl.innerHTML = formatCatBadge(m.category || '-');

  const priceEl = node.querySelector('.card__price');
  if (priceEl) priceEl.textContent = money(m.price);

  const stok = Number(m.stock||0);
  let stockEl = node.querySelector('.card__stock');
  if (!stockEl){
    stockEl = document.createElement('div');
    stockEl.className = 'card__stock muted';
    imgEl2?.insertAdjacentElement('afterend', stockEl);
  }
  stockEl.textContent = stok>0 ? `Sisa stok: ${stok}` : 'Stok habis';
  stockEl.classList.toggle('is-empty', stok===0);
  stockEl.classList.toggle('is-low', stok>0 && stok<=3);

  const qtyInput2 = node.querySelector('.qty');
  const addBtn2   = node.querySelector('.add-btn');
  if (qtyInput2){
    qtyInput2.disabled = stok<=0;
    qtyInput2.max = Math.max(1, stok||1);
    if (!qtyInput2.value || Number(qtyInput2.value) < 1) qtyInput2.value = Math.min(1, Math.max(0, stok));
  }
  if (addBtn2){
    addBtn2.disabled = stok<=0;
    addBtn2.dataset.label = addBtn2.dataset.label || addBtn2.textContent || 'Tambah';
    addBtn2.textContent = stok<=0 ? 'Stok Habis' : addBtn2.dataset.label;
  }

  return node;
}

/* =============== Grid renderers =============== */
// Best Seller => tampil saat chip kosong (Semua) atau chip Best dipilih
function renderBest(){
  const mount = byId('bestGrid'), sec = byId('sec-best');
  if (!mount || !sec) return;

  const bestLC = BEST_CATEGORY.toLowerCase();
  const selLC  = (State.selectedCat || '').toLowerCase();

  const shouldShow = (selLC === '') || (selLC === bestLC);
  if (!shouldShow){
    sec.hidden = true;
    mount.innerHTML = '';
    return;
  }

  const list = State.items
    .filter(x => x.active)
    .filter(x => String(x.category||'').toLowerCase() === bestLC);

  mount.innerHTML = '';
  if (!list.length){ sec.hidden = true; return; }
  sec.hidden = false;

  const frag = document.createDocumentFragment();
  list.forEach(m => {
    const n = createMenuCard(m);
    n.classList.add('card--mini'); // rail horizontal kecil (scroll)
    frag.appendChild(n);
  });
  mount.appendChild(frag);
}

// Strip (Paket & Promo) => tampil saat chip kosong (Semua) atau chip Strip dipilih
function renderStrip(){
  const mount = byId('stripGrid'), sec = byId('sec-strip');
  if (!mount || !sec) return;

  const stripLC = STRIP_CATEGORY.toLowerCase();
  const selLC   = (State.selectedCat || '').toLowerCase();

  const shouldShow = (selLC === '') || (selLC === stripLC);
  if (!shouldShow){
    sec.hidden = true;
    mount.innerHTML = '';
    return;
  }

  const list = State.items
    .filter(x => x.active)
    .filter(x => String(x.category||'').toLowerCase() === stripLC);

  mount.innerHTML = '';
  if (!list.length){ sec.hidden = true; return; }
  sec.hidden = false;

  const frag = document.createDocumentFragment();
  list.forEach(m => {
    const n = createMenuCard(m);
    n.classList.add('card--wide'); // kartu melebar 1×4
    frag.appendChild(n);
  });
  mount.appendChild(frag);
}

// Grid menu normal: sembunyikan kategori khusus dari grid normal
function renderMenu(){
  const grid  = byId('menuGrid'); if (!grid) return;
  const empty = byId('menuEmpty');

  const bestLC  = BEST_CATEGORY.toLowerCase();
  const stripLC = STRIP_CATEGORY.toLowerCase();
  const selLC   = (State.selectedCat || '').toLowerCase();
  const isSpecialSel = (selLC === bestLC || selLC === stripLC);

  let list = [];
  if (!isSpecialSel){
    list = filterItems().filter(m => {
      const cat = String(m.category||'').toLowerCase();
      return cat !== bestLC && cat !== stripLC;
    });
  }

  grid.innerHTML = '';
  if (!list.length){
    if (empty) empty.hidden = isSpecialSel ? true : false;
    return;
  }
  if (empty) empty.hidden = true;

  const frag = document.createDocumentFragment();
  list.forEach(m => frag.appendChild(createMenuCard(m)));
  grid.appendChild(frag);
}

/* =============== Skeleton =============== */
function templateClone(id){
  const t = byId(id);
  if (t && 'content' in t) return t.content.firstElementChild.cloneNode(true);
  // fallback sederhana bila template tidak ada
  const div = document.createElement('div');
  div.className = 'skel-card';
  div.innerHTML = `
    <div class="skel-img shimmer"></div>
    <div class="skel-body">
      <div class="skel-line shimmer" style="width:70%"></div>
      <div class="skel-line shimmer" style="width:40%"></div>
      <div class="skel-line shimmer" style="width:55%"></div>
    </div>`;
  return div;
}

function fillWithSkeleton(mountId, tplId, count){
  const mount = byId(mountId); if (!mount) return;
  mount.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i=0;i<count;i++) frag.appendChild(templateClone(tplId));
  mount.appendChild(frag);
  const sec = mount.closest('section'); if (sec) sec.hidden = false;
  mount.setAttribute('aria-busy','true');
}

function clearSkeleton(mountId){
  const mount = byId(mountId); if (!mount) return;
  mount.removeAttribute('aria-busy');
  // tidak perlu clear di sini; renderers akan menimpa.
}

/** Panggil saat mulai fetch data */
function showSkeleton(opts = {}){
  const {
    best = 3,
    menu = 8,
    strip = 2
  } = opts;
  fillWithSkeleton('bestGrid',  'tpl-card-mini-skel', best);
  fillWithSkeleton('menuGrid',  'tpl-card-skel',      menu);
  fillWithSkeleton('stripGrid', 'tpl-card-wide-skel', strip);
}

/** Opsional: panggil jika ingin membersihkan manual (render normal juga sudah menimpa) */
function hideSkeleton(){
  clearSkeleton('bestGrid');
  clearSkeleton('menuGrid');
  clearSkeleton('stripGrid');
}

export {
  renderChips, setChipActive, renderBest, renderStrip, renderMenu,
  showSkeleton, hideSkeleton
};
