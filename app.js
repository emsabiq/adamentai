/* =========================================================
 *  Adamentai – Frontend App (solid build: promo + layout + guards)
 *  - Katalog (chips + search, cache FE + retry)
 *  - Best Seller 3×1 & Strip (1×4) opsional (berdasarkan kategori)
 *  - Keranjang (desktop & mobile) + tombol ± & input qty
 *  - Promo code (backend `promo-validate` + fallback lokal + clear)
 *  - Admin (menu / kategori / stok / upload foto)
 *  - Null guards -> aman walau elemen belum ada
 *  - Drive image (multi-candidate) + opsi Cloudflare proxy
 *  - Chip "Semua" untuk reset filter kategori
 *  - Rate-limit tombol + spinner kecil
 *  - Konfigurasi via window.CONFIG: { BASE, PIN|ADMIN_PIN, ADMIN_TOKEN, CF_IMAGE_PROXY }
 *  - ⚡ Performa gambar: cache node kartu + cache URL gambar sukses + preconnect + prewarm
 * ========================================================= */

'use strict';

/* ===== KONFIGURASI (overrideable lewat window.CONFIG) ===== */
// Default (boleh diubah di build dev)
let BASE        = 'https://script.google.com/macros/s/AKfycbzKtWlxd_I4x-o7gnPy7spjSoMxDZm01VtrRlHPD5yd3tvKq6X3t19ZM4-qUVT6dF8K/exec';
let ADMIN_PIN   = '1234';
let ADMIN_TOKEN = '';
let CF_IMAGE_PROXY = ''; 
// Contoh CF_IMAGE_PROXY:
// 'https://your-proxy.example.com/?u=${url}'
// atau 'https://your-proxy.example.com/cdn-cgi/image/width=1000,format=auto,quality=85/${url}'

// Override dari window.CONFIG bila ada
(function applyRuntimeConfig(){
  try{
    const cfg = (window && window.CONFIG) || {};
    if (cfg.BASE) BASE = cfg.BASE;
    if (cfg.PIN) ADMIN_PIN = cfg.PIN;
    if (cfg.ADMIN_PIN) ADMIN_PIN = cfg.ADMIN_PIN;
    if (cfg.ADMIN_TOKEN) ADMIN_TOKEN = cfg.ADMIN_TOKEN;
    if (cfg.CF_IMAGE_PROXY) CF_IMAGE_PROXY = cfg.CF_IMAGE_PROXY;
  }catch(_){}
})();

/* ===== KATEGORI KHUSUS (untuk layout opsional) ===== */
const BEST_CATEGORY  = 'Best Seller'; // grid 3×1
const STRIP_CATEGORY = 'Paket & Promo'; // 1×4 melebar

/* ===== PROMO STATE ===== */
let coupon = null; // {code, type:'percent'|'flat', value}

/* ===== STATE ===== */
let cats = [];
let items = [];
let itemsAdmin = [];
let selectedCat = '';
let cart = [];

/* ===== Index kategori & normalizer ===== */
let catById = Object.create(null);

function normalizeCategory(c){
  const low = Object.fromEntries(Object.entries(c).map(([k,v])=>[String(k).toLowerCase(), v]));
  const id   = low.id ?? low.cat_id ?? low.kategori_id ?? low.categoryid ?? low.kode ?? low.code ?? (low.name || low.nama);
  const name = (low.name ?? low.nama ?? low.category ?? low.kategori ?? String(id||'')).toString().trim();
  return { id:String(id), name };
}
function buildCatIndex(list){
  catById = Object.create(null);
  (list||[]).forEach(c => { catById[String(c.id)] = c.name; });
}

function normalizeMenuItem(x){
  const low = Object.fromEntries(Object.entries(x).map(([k,v])=>[String(k).toLowerCase(), v]));

  // ambil nama kategori langsung, atau map dari id
  let catName =
    (low.category ?? low.kategori ?? low.cat ?? low.category_name ?? low.namakategori ?? '').toString().trim();
  const catId = low.category_id ?? low.cat_id ?? low.kategori_id ?? low.catid ?? low.categoryid;
  if (!catName && (catId!==undefined && catId!==null)) catName = catById[String(catId)] || '';

  const active =
    (typeof low.active === 'string' ? low.active.toUpperCase()==='Y' : !!low.active) ||
    (typeof low.status === 'string' ? low.status.toUpperCase()==='Y' : false);

  return {
    ...x,
    category: catName,                                 // <-- selalu isi nama kategori
    price: Number(low.price ?? x.price ?? 0),
    stock: Number(low.stock ?? low.stok ?? x.stock ?? 0),
    active
  };
}


/* ===== STORE ===== */
const Store = {
  load() {
    try { cart = JSON.parse(localStorage.getItem('adm_cart') || '[]'); } catch { cart = []; }
  },
  save() {
    localStorage.setItem('adm_cart', JSON.stringify(cart));
  }
};

/* ===== UI HELPERS (spinner / rate-limit) ===== */
function setLoading(el, v){
  if (!el) return;
  if (v){
    if (!el.dataset.oldHtml) el.dataset.oldHtml = el.innerHTML;
    el.classList.add('is-loading');
    el.disabled = true;
    // spinner kecil (gunakan CSS jika ada .spinner); fallback teks
    el.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${el.textContent || '...'}</span>`;
  } else {
    el.classList.remove('is-loading');
    el.disabled = false;
    if (el.dataset.oldHtml){ el.innerHTML = el.dataset.oldHtml; delete el.dataset.oldHtml; }
  }
}

function focusCustomerField(el, inDrawer){
  // buka panel <details> bila tertutup
  const det = (inDrawer ? $('#cartDrawer details.collapsible') : $('aside.cart details.collapsible'));
  if (det && !det.open) det.open = true;

  // scroll halus ke input yg salah
  if (inDrawer){
    const cont = $('#cartDrawer .drawer__customer');
    if (cont && el){
      const top = el.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop - 12;
      cont.scrollTo({ top, behavior:'smooth' });
    }
  } else {
    el?.scrollIntoView({ block:'center', behavior:'smooth' });
  }

  // highlight singkat
  el?.classList.add('field-error');
  setTimeout(()=> el?.classList.remove('field-error'), 1600);
}

// pembungkus aksi tombol agar tidak spam
function withLock(btn, fn, cooldown=350){
  let locked = false, last=0;
  return async function(...args){
    const now = Date.now();
    if (locked || (now-last) < cooldown) return;
    locked = true; last = now; setLoading(btn, true);
    try { return await fn.apply(this, args); }
    finally { setLoading(btn, false); locked = false; }
  };
}

/* ===== UTIL ===== */

/* ===== DATE HELPERS (untuk tampilan singkat) ===== */
function _parseToDate(v){
  if (!v && v!==0) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') { const d = new Date(v); return isNaN(d) ? null : d; }
  // terima ISO (yyyy-mm-dd) atau string lain
  const d = new Date(String(v).replace(/-/g,'/'));
  return isNaN(d) ? null : d;
}
const _MONTHS_ID = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
function fmtDateShort(v){
  const d = _parseToDate(v);
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = _MONTHS_ID[d.getMonth()];
  const yyyy = d.getFullYear();
  return `${dd} ${mm} ${yyyy}`;
}

// --- Normalisasi nama field kategori & tipe aktif
function normalizeMenuItem(x){
  const cat =
    x.category ?? x.cat ?? x.kategori ?? x.category_name ?? x.cat_name ?? '';
  const active =
    typeof x.active === 'string' ? x.active.toUpperCase() === 'Y' : !!x.active;
  return {
    ...x,
    category: String(cat).trim(),
    active,
    price: Number(x.price || 0),
    stock: Number(x.stock || 0),
  };
}

const $  = (s, p=document) => p.querySelector(s);
const $$ = (s, p=document) => [...p.querySelectorAll(s)];
const byId = (id) => document.getElementById(id);
const fmtIDR = new Intl.NumberFormat('id-ID');
const money = (n) => 'Rp' + fmtIDR.format(Number(n||0));

function toast(msg, ms=2200){
  const sb = byId('snackbar');
  if (!sb) { console.warn('Toast:', msg); return; }
  sb.textContent = msg;
  sb.classList.add('show');
  setTimeout(()=> sb.classList.remove('show'), ms);
}

function formatCatBadge(cat){
  const c = String(cat||'');
  const lc = c.toLowerCase();
  const cls = lc === BEST_CATEGORY.toLowerCase()  ? 'badge badge--best'
           : lc === STRIP_CATEGORY.toLowerCase() ? 'badge badge--strip'
           : lc.includes('promo')                ? 'badge badge--promo'
           : 'badge';
  return c ? `<span class="${cls}">${escapeHTML(c)}</span>` : '-';
}

function escapeHTML(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function setText(id, txt){ const el = byId(id); if (el) el.textContent = txt; }
// update semua badge count sekaligus
function updateCartBadges(count){
  setText('cartCount', String(count));
  setText('cartCountBar', String(count));
  $$('[data-cart-count]').forEach(el => { el.textContent = String(count); });
}
function setDisabled(id, v){ const el = byId(id); if (el) el.disabled = !!v; }

function setMoneyText(el, val, strike=false){
  if (!el) return;
  if (strike) el.innerHTML = `<s>${money(val)}</s>`;
  else el.textContent = money(val);
}

// sinkron state kontrol promo (input/tombol)
function togglePromoControls(){
  const has = !!coupon;
  ['promo_code','promo_code_m'].forEach(id=>{
    const el = byId(id); if (el) el.readOnly = has;
  });
  ['btnPromo','btnPromo_m'].forEach(id=>{
    const b = byId(id); if (b) b.disabled = has;
  });
  ['btnPromoClear','btnPromoClear_m'].forEach(id=>{
    const b = byId(id); if (b) b.hidden = !has;
  });
}


/* ===== IMAGE HELPERS (Drive multi-candidate + optional CF proxy) ===== */
const PLACEHOLDER_IMG =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="%23f3f4f6"/><text x="50%" y="50%" font-family="Arial, sans-serif" font-size="20" fill="%239ca3af" text-anchor="middle" dominant-baseline="middle">No image</text></svg>';

function extractDriveId(input){
  const s = (input || '').trim();
  if (!s) return '';
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s) && !s.includes('http') && !/\s/.test(s)) return s;
  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/uc\?id=([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/thumbnail\?id=([a-zA-Z0-9_-]+)/,
    /drive\.usercontent\.google\.com\/uc\?id=([a-zA-Z0-9_-]+)/,
    /lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/,
  ];
  for (const re of patterns){ const m = s.match(re); if (m) return m[1]; }
  try { const url = new URL(s); const id = url.searchParams.get('id'); if (id) return id; } catch(_){}
  return '';
}

function proxyIfNeeded(u){
  if (!CF_IMAGE_PROXY) return u;
  // format 1: ...?u=${url}
  if (CF_IMAGE_PROXY.includes('${url}')) return CF_IMAGE_PROXY.replace('${url}', encodeURIComponent(u));
  // format 2: .../<encoded_url>
  if (CF_IMAGE_PROXY.endsWith('/')) return CF_IMAGE_PROXY + encodeURIComponent(u);
  return CF_IMAGE_PROXY + '/' + encodeURIComponent(u);
}

function driveUrlCandidates(uOrId){
  const id = extractDriveId(uOrId);
  const raw = id ? [
    `https://drive.usercontent.google.com/uc?id=${id}&export=view`,
    `https://lh3.googleusercontent.com/d/${id}=w2000`,
    `https://lh3.googleusercontent.com/d/${id}`,
    `https://drive.google.com/thumbnail?id=${id}&sz=w2000`,
    `https://drive.google.com/uc?export=view&id=${id}`,
    `https://drive.google.com/uc?id=${id}`,
    `https://drive.google.com/uc?export=download&id=${id}`,
  ] : [uOrId, PLACEHOLDER_IMG];
  return raw.map(proxyIfNeeded);
}

/* ====== FETCH helper: timeout + retry ====== */
async function post(route, payload={}, isAdmin=false){
  const body = JSON.stringify(isAdmin && ADMIN_TOKEN ? {...payload, admin_token: ADMIN_TOKEN} : payload);

  const doFetch = (signal)=> fetch(`${BASE}?route=${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // hindari preflight
    body, signal
  });

  const TIMEOUT_MS = 9000;
  for (let attempt=1; attempt<=2; attempt++){
    const ctrl = new AbortController();
    const to = setTimeout(()=> ctrl.abort(), TIMEOUT_MS);
    try{
      const res = await doFetch(ctrl.signal);
      clearTimeout(to);
      const json = await res.json().catch(()=> ({}));
      return json;
    }catch(e){
      clearTimeout(to);
      if (attempt===2) return { ok:false, error:'network_timeout' };
      await new Promise(r=>setTimeout(r, 400));
    }
  }
}

/* ====== FILE util ====== */
function fileToDataURL(file){
  return new Promise((res, rej)=>{
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/* ====== HELPER STOK ====== */
function getItemById(id){ return itemsAdmin.find(x=> x.id===id) || items.find(x=> x.id===id); }
function getStock(id){ const it = getItemById(id); return Number(it?.stock || 0); }

/* ===== ⚡ IMAGE & CARD CACHE ===== */
const CARD_CACHE = new Map();   // id item -> node kartu (dipakai ulang)
const IMG_OK_URL = new Map();   // key (id atau url asli) -> url kandidat yang berhasil

function addPreconnectHosts(){
  const hosts = new Set([
    'https://lh3.googleusercontent.com',
    'https://drive.usercontent.google.com',
    'https://drive.google.com'
  ]);
  if (CF_IMAGE_PROXY){
    try {
      const u = CF_IMAGE_PROXY.includes('http')
        ? new URL(CF_IMAGE_PROXY.replace('${url}','https://x'))
        : null;
      if (u) hosts.add(u.origin);
    }catch(_){}
  }
  hosts.forEach(h=>{
    if (document.head.querySelector(`link[data-precon="${h}"]`)) return;
    const l1 = document.createElement('link'); l1.rel='preconnect'; l1.href=h; l1.setAttribute('data-precon',h);
    const l2 = document.createElement('link'); l2.rel='dns-prefetch'; l2.href=h;
    document.head.appendChild(l1); document.head.appendChild(l2);
  });
}

/* Prefetch beberapa gambar awal agar cache browser hangat */
function prewarmImages(limit=12){
  const list = (items||[]).slice(0, limit);
  list.forEach(m=>{
    const key = m.id || m.image_url;
    if (IMG_OK_URL.has(key)) return;
    const cands = driveUrlCandidates(m.image_url);
    let i = 0;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload  = ()=> { IMG_OK_URL.set(key, img.src); };
    img.onerror = ()=> { i++; if (i < cands.length) img.src = cands[i]; };
    img.src = cands[i];
  });
}

/* ====== TABS (Order/Admin) ====== */
function setMainTab(tab){
  $$('.topnav .tab').forEach(b=>{
    const is = b.dataset.tab === tab;
    b.classList.toggle('is-active', is);
    b.setAttribute('aria-selected', is ? 'true':'false');
  });
  byId('section-order')?.classList.toggle('is-active', tab==='order');
  byId('section-admin')?.classList.toggle('is-active', tab==='admin');
}
function setSubTab(sub){
  $$('.subtabs .subtab').forEach(b=>{
    const is = b.dataset.sub === sub;
    b.classList.toggle('is-active', is);
  });
  $$('.sub').forEach(s=> s.classList.remove('is-active'));
  byId(`sub-${sub}`)?.classList.add('is-active');

  if (sub === 'promo' && byId('tblPromo')) loadPromos();
}

/* ====== CATEGORIES (chips) ====== */
function renderChips(){
  const mount = byId('chipsCatMount'); if (!mount) return;
  const chips = [
    `<button class="chip" data-cat="" role="tab" aria-selected="true">Semua</button>`,
    ...cats.map(c => `<button class="chip" data-cat="${escapeHTML(c.name)}" role="tab">${escapeHTML(c.name)}</button>`)
  ].join('');
  mount.innerHTML = chips;
  setChipActive(selectedCat || '');
}
function setChipActive(catValue){
  selectedCat = catValue;
  $$('.chips-scroll .chip').forEach(chip=>{
    const is = (chip.dataset.cat || '') === (selectedCat || '');
    chip.classList.toggle('is-active', is);
    chip.setAttribute('aria-selected', is ? 'true' : 'false');
  });
}

/* ====== MENU (cards) ====== */
function filterItems(){
  const qEl = byId('q');
  const q = (qEl?.value || '').trim().toLowerCase();
  return items.filter(m=>{
    if (selectedCat && String(m.category||'').toLowerCase() !== selectedCat.toLowerCase()) return false;
    if (q && !(String(m.name).toLowerCase().includes(q) || String(m.category||'').toLowerCase().includes(q))) return false;
    return true;
  });
}

function createMenuCard(m){
  // pakai node cache bila sudah ada
  let node = CARD_CACHE.get(m.id);
  if (!node){
    const tpl = byId('tpl-card'); 
    node = tpl ? tpl.content.firstElementChild.cloneNode(true) : document.createElement('div');

    // === IMG: sekali setup + resolved-url cache ===
    const img = $('.card__img', node);
    if (img){
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.alt = m.name || 'menu';

      const resolved = IMG_OK_URL.get(m.id) || IMG_OK_URL.get(m.image_url);
      if (resolved){
        img.src = resolved;
      } else {
        const candidates = driveUrlCandidates(m.image_url);
        let i = 0;
        function tryNext(){ img.src = candidates[i++] || PLACEHOLDER_IMG; }
        img.addEventListener('load', function onOk(){
          IMG_OK_URL.set(m.id, img.src);
          IMG_OK_URL.set(m.image_url, img.src);
          img.removeEventListener('load', onOk);
        });
        img.onerror = tryNext; tryNext();
      }
    }

    // === event listener tombol/add & qty (sekali saja) ===
    const addBtn = $('.add-btn', node);
    const qty    = $('.qty', node);
    if (qty){
      qty.min = 1; qty.step = 1;
      qty.addEventListener('input', ()=> {
        let v = Number(qty.value||1);
        const stok = getStock(m.id);
        if (v < 1) v = 1;
        if (stok > 0 && v > stok) v = stok;
        qty.value = v;
      });
    }
    if (addBtn){
      addBtn.addEventListener('click', withLock(addBtn, ()=> {
        const q = Math.max(1, Number(qty?.value || 1));
        const it = getItemById(m.id) || m;
        addToCart(it.id, it.name, Number(it.price||m.price), q);
      }, 250));
    }

    CARD_CACHE.set(m.id, node);
  }

  // === update konten dinamis setiap render ===
  const img  = $('.card__img', node);
  if (img) img.alt = m.name || 'menu';
  $('.card__title', node).textContent = m.name;
  $('.card__meta',  node).textContent = m.category || '-';
  $('.card__price', node).textContent = money(m.price);

  // stok
  const stok = Number(m.stock||0);
  let stockEl = $('.card__stock', node);
  if (!stockEl){
    stockEl = document.createElement('div');
    stockEl.className = 'card__stock muted';
    img?.insertAdjacentElement('afterend', stockEl);
  }
  stockEl.textContent = stok>0 ? `Sisa stok: ${stok}` : 'Stok habis';
  stockEl.classList.toggle('is-empty', stok===0);
  stockEl.classList.toggle('is-low', stok>0 && stok<=3);

  const qty = $('.qty', node);
  const addBtn = $('.add-btn', node);
  if (qty){
    qty.disabled = stok<=0;
    qty.max = Math.max(1, stok||1);
    if (!qty.value || Number(qty.value) < 1) qty.value = Math.min(1, Math.max(0, stok));
  }
  if (addBtn){
    addBtn.disabled = stok<=0;
    addBtn.dataset.label = addBtn.dataset.label || addBtn.textContent || 'Tambah';
    addBtn.textContent = stok<=0 ? 'Stok Habis' : addBtn.dataset.label;
  }

  return node;
}

/* ====== GRID RENDERERS (Best / Normal / Strip) ====== */
/* ===== GRID RENDERERS (Best / Strip / Menu) ===== */

// BEST SELLER => muncul saat chip "Semua" ATAU saat chip "Best Seller" dipilih
function renderBest(){
  const mount = byId('bestGrid'), sec = byId('sec-best');
  if (!mount || !sec) return;

  const bestLC = BEST_CATEGORY.toLowerCase();
  const selLC  = (selectedCat || '').toLowerCase();

  // tampil di default (tanpa filter) ATAU saat chip Best Seller
  const shouldShow = (selLC === '') || (selLC === bestLC);
  if (!shouldShow){
    sec.hidden = true;
    mount.innerHTML = '';
    return;
  }

  const list = items
    .filter(x => x.active)
    .filter(x => String(x.category||'').toLowerCase() === bestLC); // semua item (tanpa limit)

  mount.innerHTML = '';
  if (!list.length){ sec.hidden = true; return; }
  sec.hidden = false;

  const frag = document.createDocumentFragment();
  list.forEach(m => {
    const n = createMenuCard(m);
    n.classList.add('card--mini'); // rail horizontal kecil (geser)
    frag.appendChild(n);
  });
  mount.appendChild(frag);
}

// STRIP (Paket & Promo) => muncul saat chip "Semua" ATAU saat chip "Paket & Promo" dipilih
function renderStrip(){
  const mount = byId('stripGrid'), sec = byId('sec-strip');
  if (!mount || !sec) return;

  const stripLC = STRIP_CATEGORY.toLowerCase();
  const selLC   = (selectedCat || '').toLowerCase();

  const shouldShow = (selLC === '') || (selLC === stripLC);
  if (!shouldShow){
    sec.hidden = true;
    mount.innerHTML = '';
    return;
  }

  const list = items
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

// MENU NORMAL => selalu sembunyikan item kategori khusus dari grid normal
// (kecuali user pilih kategori biasa; kalau chip khusus dipilih, grid dikosongkan)
function renderMenu(){
  const grid  = byId('menuGrid'); if (!grid) return;
  const empty = byId('menuEmpty');

  const bestLC  = BEST_CATEGORY.toLowerCase();
  const stripLC = STRIP_CATEGORY.toLowerCase();
  const selLC   = (selectedCat || '').toLowerCase();
  const isSpecialSel = (selLC === bestLC || selLC === stripLC);

  // Saat chip khusus dipilih, biarkan section khusus yg tampil; grid normal kosong
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


/* ====== CART ====== */
function addToCart(id, name, price, qty=1){
  const stok = getStock(id);
  if (stok <= 0){ toast('Stok habis'); return; }
  const exist = cart.find(c => c.id===id);
  const already = exist ? exist.qty : 0;
  const remaining = stok - already;
  if (remaining <= 0){ toast('Stok tidak cukup (tersisa 0)'); return; }

  const addQty = Math.min(qty, remaining);
  if (exist) exist.qty += addQty; else cart.push({ id, name, price, qty: addQty });

  Store.save();
  renderCart();

  if (addQty < qty){ toast(`Stok tidak cukup. Ditambahkan ${addQty} (sisa ${stok - (already + addQty)})`); }
  else { toast('Ditambahkan ke keranjang'); }
}
function delCartAt(idx){ cart.splice(idx,1); Store.save(); renderCart(); }
function emptyCart(){ cart = []; Store.save(); renderCart(); }

function setCartQtyAt(idx, newQty){
  const c = cart[idx]; if (!c) return;
  const stok = getStock(c.id);
  const v = Math.max(1, Math.min(Number(newQty||1), Math.max(0, stok)));
  if (v !== c.qty){
    c.qty = v;
    Store.save();
    renderCart();
  }
  if (v < newQty) toast('Melebihi stok tersedia');
}

/* ====== TOTALS & PROMO ====== */
function calcTotals(){
  const subtotal = cart.reduce((s,c)=> s + c.qty*c.price, 0);
  let discount = 0;
  if (coupon){
    if (coupon.type === 'percent') discount = Math.floor(subtotal * (coupon.value||0) / 100);
    if (coupon.type === 'flat')    discount = Math.min(subtotal, Number(coupon.value||0));
  }
  const total = Math.max(0, subtotal - discount);
  return { subtotal, discount, total };
}

function clearCoupon(){
  if (!coupon) return;
  coupon = null;
  togglePromoControls();
  toast('Kode promo dihapus');
  renderCart();
}

async function applyCoupon(code){
  const clean = (code||'').trim();
  if (!clean) return toast('Masukkan kode promo');

  const payload = { code: clean, items: cart.map(c=>({id:c.id, qty:c.qty, price:c.price})) };
  const res = await post('promo-validate', payload);
  const ok = !!(res && (res.ok || res.valid));

  if (!ok){
    const err = res?.error || 'Kode promo tidak valid';
    // ⛔ default: JANGAN fallback. 
    // ✅ Hanya kalau kamu mengaktifkan secara eksplisit:
    if (window.CONFIG && window.CONFIG.PROMO_LOCAL_FALLBACK){
      const fallback = {
        'HEMAT10': { type:'percent', value:10 },
        'POTONG5': { type:'flat', value:5000 },
      }[clean.toUpperCase()];
      if (fallback){
        coupon = { code: clean.toUpperCase(), ...fallback };
        togglePromoControls();
        toast('Kode promo diterapkan (fallback)');
        renderCart();
        return;
      }
    }
    coupon = null;
    togglePromoControls();
    toast(err);           // contoh: "Belum memenuhi minimum belanja"
    renderCart();
    return;
  }

  const data = res.data || res;
  const t = (data.type||'').toLowerCase();
  const v = Number(data.value||0);
  if (!t || !(v>0)){ coupon = null; togglePromoControls(); toast('Respon promo tidak valid'); renderCart(); return; }

  coupon = { code: clean.toUpperCase(), type: t, value: v };
  togglePromoControls();
  toast('Kode promo diterapkan');
  renderCart();
}


/* ====== RENDER CART (± controls) ====== */
function renderCart(){
  const { subtotal, discount, total } = calcTotals();
  const hasDisc = discount > 0;

  // --- Update via ID (kompatibel kode lama)
  setMoneyText(byId('cartSubtotal'),       subtotal, hasDisc);
  setMoneyText(byId('cartSubtotalMobile'), subtotal, hasDisc);
  setText('cartDiscount', '-' + money(discount));
  setText('cartTotal',    money(total));
  setText('mobileTotal',  money(total));
  // Label “Setelah diskon” (opsional, kalau ada elemennya)
  setText('cartTotalNote', hasDisc ? 'Setelah diskon' : '');
  setText('cartTotalNoteMobile', hasDisc ? 'Setelah diskon' : '');

  // --- Update via data-atribut (drawer/markup berbeda)
  $$('[data-cart-subtotal]').forEach(el => { 
    const { subtotal, discount } = calcTotals();
    el.innerHTML = discount>0 ? `<s>${money(subtotal)}</s>` : money(subtotal);
  });
  $$('[data-cart-discount]').forEach(el => { el.textContent = '-' + money(calcTotals().discount); });
  $$('[data-cart-total]').forEach(el => { el.textContent = money(calcTotals().total); });
  togglePromoControls();

  const count = cart.reduce((s,c)=> s+c.qty, 0);
  updateCartBadges(count);

  const has = cart.length>0;
  ['btnCheckout','btnCheckoutBar','btnCheckoutMobile'].forEach(id=> setDisabled(id, !has));

  // promo pill + tombol clear
  const pill = byId('promoApplied');
  if (pill){
    if (coupon){
      pill.hidden = false;
      pill.textContent = `${coupon.code} • ${coupon.type==='percent'? coupon.value+'%' : money(coupon.value)} diterapkan (klik untuk hapus)`;
    } else { pill.hidden = true; pill.textContent = ''; }
  }
  togglePromoControls();

  const tpl = byId('tpl-cart-item');

  function renderInto(box){
    if (!box || !tpl) return;
    if (!has){ box.innerHTML = '<div class="muted">Belum ada item.</div>'; return; }

    box.innerHTML = '';
    cart.forEach((c,i)=>{
      const row = tpl.content.firstElementChild.cloneNode(true);
      const stok = getStock(c.id);
      const safeQty = Math.min(c.qty, Math.max(0, stok));
      const over = c.qty > stok;

      $('.cart__name', row).textContent = c.name + (stok<=0 ? ' (Habis)' : '');

      const qtyCell = $('.cart__qty', row);
      if (qtyCell){
        qtyCell.innerHTML = `
          <div class="qtyctl" data-idx="${i}">
            <button type="button" class="qdec" aria-label="Kurangi">–</button>
            <input class="qinput" type="number" min="1" step="1" value="${safeQty}">
            <button type="button" class="qinc" aria-label="Tambah">+</button>
          </div>`;
        const wrap = $('.qtyctl', qtyCell);
        const dec = $('.qdec', wrap);
        const inc = $('.qinc', wrap);
        const inp = $('.qinput', wrap);
        dec?.addEventListener('click', ()=> setCartQtyAt(i, safeQty - 1));
        inc?.addEventListener('click', ()=> setCartQtyAt(i, safeQty + 1));
        inp?.addEventListener('input', ()=>{
          let v = Number(inp.value||1);
          if (v < 1) v = 1;
          if (v > stok) { v = stok; toast('Melebihi stok tersedia'); }
          setCartQtyAt(i, v);
        });
      }

      $('.cart__sub', row).textContent  = money(safeQty * c.price);
      if (over){ row.classList.add('warn'); row.title = `Melebihi stok. Stok tersedia: ${stok}`; }
      $('.cart__del', row)?.addEventListener('click', ()=> delCartAt(i));
      box.appendChild(row);
    });
  }

  renderInto(byId('cartItems'));       // desktop
  renderInto(byId('cartItemsMobile')); // mobile
}

/* ====== VALIDASI CART vs STOK ====== */
function validateCartAgainstStock(){
  let changed = false;
  const newCart = [];
  for (const c of cart){
    const stok = getStock(c.id);
    if (!stok || stok <= 0){ changed = true; continue; }
    if (c.qty > stok){ c.qty = stok; changed = true; }
    newCart.push(c);
  }
  if (changed){
    cart = newCart;
    Store.save();
    renderCart();
    toast('Keranjang disesuaikan dengan stok yang tersedia');
  }
}

/* ====== CHECKOUT ====== */
// --- helper: tampilkan/disable tombol Bayar + spinner kecil
function setCheckoutLoading(loading){
  const ids = ['btnCheckout','btnCheckoutBar','btnCheckoutMobile'];
  ids.forEach(id=>{
    const btn = byId(id);
    if (!btn) return;
    btn.disabled = true;
    btn.classList.toggle('is-loading', !!loading);
    if (loading){
      if (!btn.dataset._html) btn.dataset._html = btn.innerHTML;
      const label = (btn.textContent || 'Bayar').trim();
      btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${label}`;
    } else {
      btn.disabled = (cart.length===0);
      if (btn.dataset._html){ btn.innerHTML = btn.dataset._html; delete btn.dataset._html; }
    }
  });
}

// --- validasi wajib isi + fokus ke field
function firstMissingField(desktop){
// ganti cara ambil elemen di fungsi firstMissingField/checkout:
const nameEl  = desktop ? byId('cust_name')  : $('#cartDrawer #cust_name_m');
const phoneEl = desktop ? byId('cust_phone') : $('#cartDrawer #cust_phone_m');
const addrEl  = desktop ? byId('cust_addr')  : $('#cartDrawer #cust_addr_m');

  if (!nameEl?.value.trim())  return { el:nameEl,  msg:'Nama wajib diisi' };
  if (!phoneEl?.value.trim()) return { el:phoneEl, msg:'No. HP wajib diisi' };
  if (!addrEl?.value.trim())  return { el:addrEl,  msg:'Alamat wajib diisi' };
  return null;
}
function showFieldError(el,msg){
  toast(msg);
  if (!el) return;
  const inDrawer = !!el.closest('#cartDrawer');
  const det = (inDrawer ? $('#cartDrawer details.collapsible') : $('aside.cart details.collapsible'));
  if (det && !det.open) det.open = true;
  if (inDrawer){
    const cont = $('#cartDrawer .drawer__customer');
    if (cont){
      const top = el.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop - 12;
      cont.scrollTo({ top, behavior:'smooth' });
    }
  } else {
    el.scrollIntoView({ block:'center', behavior:'smooth' });
  }
  el.classList.add('field-error');
  el.focus({ preventScroll:true });
  setTimeout(()=> el.classList.remove('field-error'), 1500);
}


async function checkout(desktop=true){
  if (!cart.length) return toast('Keranjang kosong');

  // rate-limit klik beruntun
  if (checkout._pending) return;
  checkout._pending = true;
  setCheckoutLoading(true);

  try{
    // required (FE)
    const miss = firstMissingField(desktop);
    if (miss){
      if (!desktop){ openDrawer(); setTimeout(()=> showFieldError(miss.el, miss.msg), 120); }
      else { showFieldError(miss.el, miss.msg); }
      return;
    }

    validateCartAgainstStock();
    if (!cart.length){ toast('Semua item di keranjang tidak tersedia'); return; }

    const name  = (desktop ? byId('cust_name')  : byId('cust_name_m')).value.trim();
    const addr  = (desktop ? byId('cust_addr')  : byId('cust_addr_m')).value.trim();
    const phone = (desktop ? byId('cust_phone') : byId('cust_phone_m')).value.trim();
    const note  = (desktop ? byId('cust_note')  : byId('cust_note_m')) ?.value.trim() || '';

    const { subtotal, discount, total } = calcTotals();

    const payload = {
      customer_name: name,
      phone, address: addr, note, info: '',
      items: cart.map(c => ({ id: c.id, name: c.name, qty: c.qty, price: c.price })),
      coupon_code: coupon?.code || '',
      discount_value: discount,
      subtotal, total,
      finish_redirect_url: location.href
    };

    const j = await post('create-order', payload);

    if (j && j.paymentUrl){
      try{ localStorage.setItem('adm_customer', JSON.stringify({name, phone, addr})); }catch(_){}
      location.href = j.paymentUrl;
      return;
    }

    console.warn('create-order fail:', j);
    toast(j?.error === 'midtrans_error' ? 'Pembayaran tidak tersedia. Coba lagi.' : (j?.error || 'Gagal membuat transaksi'));
  } catch (err){
    console.error('checkout error', err);
    toast('Terjadi kesalahan jaringan');
  } finally {
    checkout._pending = false;
    setCheckoutLoading(false);
  }
}


/* ====== DATA LOAD (dengan cache FE) ====== */
const MENU_CACHE_KEY = 'adm_menu_cache_v6';  // ⬅️ ganti biar cache lama tidak dipakai
const MENU_CACHE_TTL = 60_000;

function loadFromCacheFast(){
  try{
    const x = JSON.parse(localStorage.getItem(MENU_CACHE_KEY)||'{}');
    if (Date.now() - (x.ts||0) < MENU_CACHE_TTL && Array.isArray(x.data)){
      itemsAdmin = x.data.slice();
      items = x.data.filter(z=>z.active);
      renderBest(); renderMenu(); renderStrip();
      renderAdminTables(); renderStockDropdown();
      prewarmImages(12); // 🔥 panaskan cache gambar dari cache FE
    }
  }catch{}
}

async function loadCats(){
  const j = await post('cat-list');
  cats = (j?.data || []).map(normalizeCategory);   // ⬅️ normalisasi
  buildCatIndex(cats);
  renderChips();
}


async function loadMenu(){
  const j = await post('menu-list');
  const raw = (j?.data || []).map(normalizeMenuItem);  // ⬅️ normalisasi
  itemsAdmin = raw.slice();
  items = raw.filter(x=> x.active);

  try{
    const ver = j?.ver || 0;
    localStorage.setItem(MENU_CACHE_KEY, JSON.stringify({ ts:Date.now(), ver, data:raw }));
  }catch(_){}

  renderBest(); renderMenu(); renderStrip();
  renderAdminTables(); renderStockDropdown();
}

/* ====== ADMIN: LOGIN ====== */
function adminLogin(){
  const ok = (byId('pin')?.value || '') === ADMIN_PIN;
  if (!ok) return toast('PIN salah');
  byId('adminGate')?.classList.add('hidden');
  byId('adminPanel')?.classList.remove('hidden');
  setSubTab('menu');
}

/* ====== ADMIN: MENU ====== */
function clearPreview(){
  const img = byId('m_prev');
  if (img){ img.src=''; img.classList.add('hidden'); }
  byId('btnClearImg')?.classList.add('hidden');
  if (byId('m_image_url')) byId('m_image_url').value='';
  if (byId('m_img'))       byId('m_img').value='';
}
function showPreview(url){
  const img = byId('m_prev'); if (!img) return;
  img.src = url; img.classList.remove('hidden');
  byId('btnClearImg')?.classList.remove('hidden');
}
function resetMenuForm(){
  ['m_id','m_name','m_price','m_stock'].forEach(id=> byId(id) && (byId(id).value=''));
  if (byId('m_active'))    byId('m_active').value='Y';
  if (byId('m_image_url')) byId('m_image_url').value='';
  if (byId('m_cat'))       byId('m_cat').value = (cats[0]?.name || '');
  clearPreview();
}
function renderAdminTables(){
  const catSel = byId('m_cat');
  if (catSel) catSel.innerHTML = cats.map(c=>`<option>${escapeHTML(c.name)}</option>`).join('');

  const table = byId('tblMenu'); if (!table) return;
  const tb = table.querySelector('tbody');
  tb.innerHTML = '';
  if (!itemsAdmin.length){
    tb.innerHTML = '<tr><td colspan="6" class="muted">Belum ada data</td></tr>';
    return;
  }

  itemsAdmin.forEach(m=>{
    // fallback bila ada id atau nama di field lain
    const kat =
      m.category ||
      m.kategori ||
      m.category_name ||
      catById[String(m.category_id ?? m.cat_id ?? m.kategori_id ?? m.categoryid)] ||
      '-';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHTML(m.name)}</td>
      <td>${escapeHTML(kat)}</td>
      <td class="right">${money(m.price)}</td>
      <td class="right">${m.stock}</td>
      <td>${m.active ? 'Y' : 'N'}</td>
      <td class="center">
        <button class="btn btn--ghost" data-action="edit" data-id="${escapeHTML(m.id)}">Edit</button>
        <button class="btn btn--ghost danger" data-action="del" data-id="${escapeHTML(m.id)}">Hapus</button>
      </td>`;
    tb.appendChild(tr);
  });
}

async function saveMenu(){
  let image_url = byId('m_image_url')?.value || '';
  const fileEl = byId('m_img');
  const f = fileEl?.files?.[0];
  if (f){
    if (f.size > 3*1024*1024) return toast('Ukuran foto > 3MB');
    const data_url = await fileToDataURL(f);
    const upBtn = byId('btnMenuSave');
    const up = await (async ()=> {
      setLoading(upBtn, true);
      const r = await post('upload-image', { data_url, name: f.name }, true);
      setLoading(upBtn, false);
      return r;
    })();
    if (!up.ok) return toast('Upload foto gagal: ' + (up.error||'')); 
    image_url = up.url; if (byId('m_image_url')) byId('m_image_url').value = image_url;
  }
  const payload = {
    id: byId('m_id')?.value || undefined,
    name: byId('m_name')?.value.trim(),
    category: byId('m_cat')?.value.trim(),
    price: Number(byId('m_price')?.value||0),
    stock: Number(byId('m_stock')?.value||0),
    active: (byId('m_active')?.value === 'Y'),
    image_url
  };
  if (!payload.name) return toast('Nama menu wajib diisi');

  const btn = byId('btnMenuSave');
  const j = await (async ()=> { setLoading(btn, true); const r = await post('menu-save', payload, true); setLoading(btn, false); return r; })();
  if (!j.ok) return toast(j.error || 'Gagal simpan');
  toast('Menu tersimpan');
  resetMenuForm();
  await reloadAll();
}
async function delMenu(id){
  if (!confirm('Hapus item ini?')) return;
  const j = await post('menu-del', { id }, true);
  if (!j.ok) return toast(j.error || 'Gagal hapus');
  toast('Terhapus');
  await reloadAll();
}
function editMenu(id){
  const m = itemsAdmin.find(x=> x.id===id);
  if (!m) return;
  byId('m_id').value = m.id;
  byId('m_name').value = m.name;
  byId('m_price').value = m.price;
  byId('m_stock').value = m.stock;
  byId('m_active').value = m.active ? 'Y' : 'N';
  byId('m_image_url').value = m.image_url || '';

  const sel = byId('m_cat');
  if (sel){
    const want =
      (m.category || m.kategori || m.category_name ||
       catById[String(m.category_id ?? m.cat_id ?? m.kategori_id ?? m.categoryid)] || '').toString().trim();
    if (want && ![...sel.options].some(o=>o.value===want)) sel.add(new Option(want, want));
    sel.value = want || (cats[0]?.name || '');
  }

  if (m.image_url) showPreview(m.image_url); else clearPreview();
  window.scrollTo({ top:0, behavior:'smooth' });
}




/* ====== ADMIN: KATEGORI ====== */
function renderCatTable(){
  const table = byId('tblCat'); if (!table) return;
  const tb = table.querySelector('tbody');
  tb.innerHTML = '';
  if (!cats.length){
    tb.innerHTML = '<tr><td colspan="2" class="muted">Belum ada data</td></tr>';
    return;
  }
  cats.forEach(c=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHTML(c.name)}</td>
      <td class="center">
        <button class="btn btn--ghost" data-cat-act="edit" data-id="${escapeHTML(c.id)}">Edit</button>
        <button class="btn btn--ghost danger" data-cat-act="del" data-id="${escapeHTML(c.id)}">Hapus</button>
      </td>`;
    tb.appendChild(tr);
  });
}
function resetCatForm(){ if (byId('c_id')) byId('c_id').value=''; if (byId('c_name')) byId('c_name').value=''; }
async function saveCat(){
  const payload = { id: byId('c_id')?.value || undefined, name: byId('c_name')?.value.trim() };
  if (!payload.name) return toast('Nama kategori wajib diisi');
  const btn = byId('btnCatSave');
  const j = await (async ()=> { setLoading(btn, true); const r = await post('cat-save', payload, true); setLoading(btn, false); return r; })();
  if (!j.ok) return toast(j.error || 'Gagal simpan');
  toast('Kategori tersimpan');
  resetCatForm();
  await loadCats();
  renderCatTable();
  renderAdminTables();
}
async function delCat(id){
  const j = await post('cat-del', { id }, true);
  if (!j.ok) return toast(j.error || 'Gagal hapus');
  toast('Terhapus');
  await loadCats();
  renderCatTable();
  renderAdminTables();
}

/* ====== ADMIN: STOK ====== */
function renderStockDropdown(){
  const sel = byId('s_item'); if (!sel) return;
  sel.innerHTML = itemsAdmin.map(m=>`<option value="${escapeHTML(m.id)}">${escapeHTML(m.name)} — stok ${m.stock}</option>`).join('');
}
async function saveStock(){
  const item_id = byId('s_item')?.value;
  const delta = Number(byId('s_delta')?.value||0);
  const note  = byId('s_note')?.value.trim();
  if (!item_id || !delta) return toast('Pilih item & isi delta');
  const btn = byId('btnStockSave');
  const j = await (async ()=> { setLoading(btn, true); const r = await post('stock-adjust', { item_id, delta, note }, true); setLoading(btn, false); return r; })();
  if (!j.ok) return toast(j.error || 'Gagal update stok');
  toast('Stok diperbarui');
  await reloadAll();
}

/* ====== ADMIN: PROMO ====== */
let promos = []; // {id, code, type, value, min_subtotal, start, end, active, note}

async function loadPromos(){
  const j = await post('promo-list', {}, true);
  promos = (j?.data || []).sort((a,b)=> a.code.localeCompare(b.code));
  renderPromoTable();
}
function renderPromoTable(){
  const tbl = byId('tblPromo'); if (!tbl) return;
  const tb = tbl.querySelector('tbody');
  tb.innerHTML = '';
  if (!promos.length){
    tb.innerHTML = '<tr><td colspan="7" class="muted">Belum ada promo</td></tr>';
    return;
  }
  promos.forEach(p=>{
    const start = fmtDateShort(p.start);
    const end   = fmtDateShort(p.end);
    const periode = (start || end) ? `${start || '—'} → ${end || '—'}` : '-';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHTML(p.code)}</td>
      <td>${p.type==='percent'?'%':'Rp'}</td>
      <td class="right">${p.type==='percent' ? (p.value+'%') : money(p.value)}</td>
      <td class="right">${p.min_subtotal? money(p.min_subtotal): '-'}</td>
      <td>${periode}</td>
      <td>${p.active ? 'Y' : 'N'}</td>
      <td class="center">
        <button class="btn btn--ghost" data-pact="edit" data-id="${escapeHTML(p.id)}">Edit</button>
        <button class="btn btn--ghost danger" data-pact="del" data-id="${escapeHTML(p.id)}">Hapus</button>
      </td>`;
    tb.appendChild(tr);
  });
}

function resetPromoForm(){
  ['p_id','p_code','p_value','p_min','p_start','p_end','p_note'].forEach(id=> byId(id) && (byId(id).value=''));
  if (byId('p_type'))   byId('p_type').value='percent';
  if (byId('p_active')) byId('p_active').value='Y';
}
function fillPromoForm(p){
  byId('p_id').value = p.id||'';
  byId('p_code').value = p.code||'';
  byId('p_type').value = p.type||'percent';
  byId('p_value').value = p.value||0;
  byId('p_min').value = p.min_subtotal||0;
  byId('p_start').value = p.start||'';
  byId('p_end').value = p.end||'';
  byId('p_active').value = p.active ? 'Y':'N';
  byId('p_note').value = p.note||'';
}
async function savePromo(){
  if (!byId('p_code')) return; // panel tidak ada
  const payload = {
    id: byId('p_id')?.value || undefined,
    code: (byId('p_code')?.value || '').trim().toUpperCase(),
    type: byId('p_type')?.value,
    value: Number(byId('p_value')?.value||0),
    min_subtotal: Number(byId('p_min')?.value||0),
    start: byId('p_start')?.value || '',
    end: byId('p_end')?.value || '',
    active: byId('p_active')?.value === 'Y',
    note: (byId('p_note')?.value || '').trim()
  };
  if (!payload.code) return toast('Kode wajib diisi');
  if (!(payload.value>0)) return toast('Nilai promo harus > 0');
  const btn = byId('btnPromoSave');
  const j = await (async ()=> { setLoading(btn, true); const r = await post('promo-save', payload, true); setLoading(btn, false); return r; })();
  if (!j.ok) return toast(j.error || 'Gagal simpan promo');
  toast('Promo tersimpan');
  resetPromoForm();
  await loadPromos();
}
async function delPromo(id){
  const j = await post('promo-del', { id }, true);
  if (!j.ok) return toast(j.error || 'Gagal hapus');
  toast('Promo terhapus');
  await loadPromos();
}

/* ====== MOBILE CART DRAWER ====== */
let _drawerPrevFocus = null;

function openDrawer(){
  const dw = byId('cartDrawer'); if (!dw) return;
  _drawerPrevFocus = document.activeElement;
  dw.classList.add('open');
  dw.removeAttribute('aria-hidden');
  dw.removeAttribute('inert');
  // arahkan fokus ke tombol tutup (atau elemen pertama di drawer)
  byId('btnCloseCart')?.focus({ preventScroll:true });
}

function closeDrawer(){
  const dw = byId('cartDrawer'); if (!dw) return;
  // kalau fokus masih di dalam drawer, pindahkan ke tombol pembuka
  if (dw.contains(document.activeElement)) {
    byId('btnOpenCart')?.focus({ preventScroll:true });
  } else if (_drawerPrevFocus) {
    // atau kembalikan fokus ke elemen sebelumnya
    try { _drawerPrevFocus.focus({ preventScroll:true }); } catch(_) {}
  }
  dw.classList.remove('open');
  dw.setAttribute('aria-hidden','true');
  dw.setAttribute('inert',''); // cegah interaksi & fokus
}

/* ====== EVENT LISTENERS ====== */
function bindEvents(){
  // Top tabs
  $$('.topnav .tab').forEach(btn=> btn.addEventListener('click', ()=> setMainTab(btn.dataset.tab)));

  // Search
  byId('q')?.addEventListener('input', ()=>{
    const v = byId('q').value.trim();
    if (byId('btnClearSearch')) byId('btnClearSearch').hidden = !v;
    renderBest(); renderMenu(); renderStrip();
  });
  byId('btnClearSearch')?.addEventListener('click', ()=>{
    byId('q').value=''; if (byId('btnClearSearch')) byId('btnClearSearch').hidden=true;
    renderBest(); renderMenu(); renderStrip();
  });

  // Chips (category)
  $('.chips-scroll')?.addEventListener('click', (e)=>{
    const btn = e.target.closest('.chip'); if (!btn) return;
    setChipActive(btn.dataset.cat || ''); 
    renderBest(); renderMenu(); renderStrip();
  });

  // Cart actions
  byId('btnEmptyCart')?.addEventListener('click', emptyCart);

  // Checkout buttons dengan lock+spinner
  const btnCheckout = byId('btnCheckout');
  const btnCheckoutBar = byId('btnCheckoutBar');
  const btnCheckoutMobile = byId('btnCheckoutMobile');
  btnCheckout  && btnCheckout .addEventListener('click', withLock(btnCheckout , ()=> checkout(true)));
  btnCheckoutBar&& btnCheckoutBar.addEventListener('click', withLock(btnCheckoutBar, ()=> checkout(false)));
  btnCheckoutMobile&& btnCheckoutMobile.addEventListener('click', withLock(btnCheckoutMobile, ()=> checkout(false)));

  // Promo apply (desktop & mobile) dengan lock
  const btnPromo = byId('btnPromo');
  const btnPromoM= byId('btnPromo_m');
  btnPromo  && btnPromo .addEventListener('click', withLock(btnPromo , ()=> applyCoupon(byId('promo_code')?.value)));
  btnPromoM && btnPromoM.addEventListener('click', withLock(btnPromoM, ()=> applyCoupon(byId('promo_code_m')?.value)));

  // Hapus promo: klik pill + tombol opsional
  byId('promoApplied')?.addEventListener('click', clearCoupon);
  byId('btnPromoClear')?.addEventListener('click', clearCoupon);
  byId('btnPromoClear_m')?.addEventListener('click', clearCoupon);   // ⬅️ baru

  // Drawer mobile
  byId('btnOpenCart')?.addEventListener('click', openDrawer);
  byId('btnOpenCartBar')?.addEventListener('click', openDrawer);
  byId('btnCloseCart')?.addEventListener('click', closeDrawer);
  byId('drawerScrim')?.addEventListener('click', closeDrawer);

  // Admin gate
  byId('btnAdminLogin')?.addEventListener('click', adminLogin);

  // Admin subtabs
  $$('.subtabs .subtab').forEach(btn=> btn.addEventListener('click', ()=> setSubTab(btn.dataset.sub)));

  // Admin: menu form
  byId('btnMenuSave')  ?.addEventListener('click', saveMenu);
  byId('btnMenuReset') ?.addEventListener('click', resetMenuForm);
  byId('m_img')        ?.addEventListener('change', (e)=>{ const f = e.target.files[0]; if (f){ showPreview(URL.createObjectURL(f)); }});
  byId('btnClearImg')  ?.addEventListener('click', clearPreview);

  // Admin: table actions (edit/del)
  byId('tblMenu')?.addEventListener('click', (e)=>{
    const b = e.target.closest('button[data-action]'); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.action === 'edit') editMenu(id);
    if (b.dataset.action === 'del') delMenu(id);
  });

  // Admin: category
  byId('btnCatSave')?.addEventListener('click', saveCat);
  byId('tblCat')?.addEventListener('click', (e)=>{
    const b = e.target.closest('button[data-cat-act]'); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset['catAct'] === 'edit'){
      const c = cats.find(x=> x.id===id);
      if (c){ if (byId('c_id')) byId('c_id').value = c.id; if (byId('c_name')) byId('c_name').value = c.name; }
    }
    if (b.dataset['catAct'] === 'del'){
      if (confirm('Hapus kategori ini?')) delCat(id);
    }
  });

  // Admin: stock
  byId('btnStockSave')?.addEventListener('click', saveStock);

  // Admin: promo
  byId('btnPromoSave') ?.addEventListener('click', savePromo);
  byId('btnPromoReset')?.addEventListener('click', resetPromoForm);
  byId('tblPromo')?.addEventListener('click', (e)=>{
    const b = e.target.closest('button[data-pact]'); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.pact === 'edit'){
      const p = promos.find(x=> x.id===id);
      if (p) fillPromoForm(p);
    }
    if (b.dataset.pact === 'del'){
      if (confirm('Hapus promo ini?')) delPromo(id);
    }
  });
}

/* ====== SET REQUIRED INPUTS ====== */
function markRequiredInputs(){
  [['cust_name',null],['cust_phone',null],['cust_addr',null],
   ['cust_name_m','#cartDrawer'],['cust_phone_m','#cartDrawer'],['cust_addr_m','#cartDrawer']]
  .forEach(([id,scope])=>{
    const el = scope ? document.querySelector(`${scope} #${id}`) : byId(id);
    if (el){
      el.required = true;
      if (!el.placeholder){
        if (id.includes('name')) el.placeholder = 'Nama *';
        else if (id.includes('phone')) el.placeholder = 'No. HP *';
        else el.placeholder = 'Alamat *';
      }
    }
  });
}


/* ====== RELOAD ALL ====== */
async function reloadAll(){
  await loadCats();
  await loadMenu();
  renderCatTable();
  validateCartAgainstStock();
  renderCart();

  // jika panel promo admin ada, refresh
  if (byId('tblPromo')) await loadPromos();
}

/* ====== INIT ====== */

function dedupeIds(list){
  list.forEach(id=>{
    const nodes = document.querySelectorAll('#'+id);
    nodes.forEach((el, i)=>{ if (i>0) el.removeAttribute('id'); });
  });
}
// panggil saat init (sebelum bindEvents)

(function init(){
  setMainTab('order');
  // 🔽 buang id ganda agar byId() tidak bingung
  dedupeIds(['cust_name_m','cust_phone_m','cust_addr_m','cust_note_m','promoApplied','mobileTotal']);
  addPreconnectHosts();        // ⚡ preconnect host gambar
  Store.load();
  bindEvents();
  markRequiredInputs();
  // coba render cepat kalau ada cache FE
  loadFromCacheFast();
  reloadAll().catch(err=> toast('Init error: '+err.message));
})();
