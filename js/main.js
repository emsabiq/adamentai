'use strict';
// Entry point: init, data loading (cache + network), event bindings, tab switch (ES2019-safe)

import { $, byId, toast, setLoading, withLock, setPageLoading } from './utils.js';
import { Api } from './api.js';
import {
  State, Store,
  buildCatIndex, normalizeCategory, normalizeMenuItem
} from './state.js';
import { addPreconnectHosts, prewarmImages } from './images.js';
import { renderChips, setChipActive, renderBest, renderStrip, renderMenu, showSkeleton } from './catalog.js';
import {
  renderCart,
  validateCartAgainstStock,
  applyCoupon,      // dari cart.js
  clearCoupon       // dari cart.js
} from './cart.js';
import {
  checkout,
  togglePromoControls,
  openDrawer, closeDrawer, markRequiredInputs
} from './checkout.js';
import { MENU_CACHE_KEY, MENU_CACHE_TTL } from './config.js';

// Penting: load modul admin agar event listeners (adm:login, dll) aktif
import './admin.js';

/* =====================
 * Tabs (Main/Admin)
 * ===================== */
function setMainTab(tab){
  var tabs = document.querySelectorAll('.topnav .tab');
  for (var i=0;i<tabs.length;i++){
    var b = tabs[i];
    var is = (b.dataset && b.dataset.tab) === tab;
    b.classList.toggle('is-active', is);
    b.setAttribute('aria-selected', is ? 'true':'false');
  }
  var secOrder = byId('section-order');
  if (secOrder) secOrder.classList.toggle('is-active', tab==='order');
  var secAdmin = byId('section-admin');
  if (secAdmin) secAdmin.classList.toggle('is-active', tab==='admin');
}

function setSubTab(sub){
  var subtabs = document.querySelectorAll('.subtabs .subtab');
  for (var i=0;i<subtabs.length;i++){
    var b = subtabs[i];
    var is = (b.dataset && b.dataset.sub) === sub;
    b.classList.toggle('is-active', is);
  }
  var subs = document.querySelectorAll('.sub');
  for (var j=0;j<subs.length;j++) subs[j].classList.remove('is-active');

  var target = byId('sub-' + sub);
  if (target) target.classList.add('is-active');

  if (sub === 'promo' && byId('tblPromo')) loadPromos();
}

/* =====================
 * Cache-First fast render
 * ===================== */
function loadFromCacheFast(){
  try{
    var raw = localStorage.getItem(MENU_CACHE_KEY) || '{}';
    var x = JSON.parse(raw);
    var ok = (Date.now() - (x.ts || 0) < MENU_CACHE_TTL) && Array.isArray(x.data);
    if (ok){
      State.itemsAdmin = x.data.slice();
      State.items = x.data.filter(function(z){ return z.active; });
      renderBest(); renderMenu(); renderStrip();
      // panaskan gambar
      prewarmImages(State.items, 12);
      return;
    }
    // tidak ada cache → tampilkan skeleton supaya tidak "kosong"
    showSkeleton(8);
  }catch (e){
    showSkeleton(8);
  }
}

/* =====================
 * Network loaders
 * ===================== */
async function loadCats(){
  var j = null;
  try { j = await Api.cats(); } catch(_){ j = null; }
  var list = ((j && j.data) ? j.data : []).map(normalizeCategory);
  State.cats = list;
  buildCatIndex(list);
  renderChips();
}

async function loadMenu(){
  var j = null;
  try { j = await Api.menu(); } catch(_){ j = null; }

  var raw = ((j && j.data) ? j.data : []).map(normalizeMenuItem);
  State.itemsAdmin = raw.slice();
  State.items = raw.filter(function(x){ return x.active; });

  try {
    var ver = (j && j.ver) || 0;
    localStorage.setItem(MENU_CACHE_KEY, JSON.stringify({ ts:Date.now(), ver:ver, data:raw }));
  } catch(_){}

  renderBest(); renderMenu(); renderStrip();

  // stok dropdown untuk admin (kalau panel kebuka)
  var ev = new Event('adm:dataset-ready');
  window.dispatchEvent(ev);
}

async function loadPromos(){
  var j = null;
  try { j = await Api.promoList(); } catch(_){ j = null; }
  var promos = ((j && j.data) ? j.data : []).sort(function(a,b){ return String(a.code).localeCompare(String(b.code)); });
  // render tabel promo (admin.js punya listener/renderer sendiri)
  var evt = new CustomEvent('adm:promos', { detail: { promos: promos }});
  window.dispatchEvent(evt);
}

/* =====================
 * Admin: Promo (form helpers)
 * (dijaga di sini agar tombol edit/hapus di tabel tetap bekerja)
 * ===================== */
function resetPromoForm(){
  var ids = ['p_id','p_code','p_value','p_min','p_start','p_end','p_note'];
  for (var i=0;i<ids.length;i++){ var el = byId(ids[i]); if (el) el.value=''; }
  var t = byId('p_type');   if (t) t.value='percent';
  var a = byId('p_active'); if (a) a.value='Y';
}
function fillPromoForm(p){
  var set = function(id, val){ var el = byId(id); if (el) el.value = val; };
  set('p_id',    p.id || '');
  set('p_code',  p.code || '');
  set('p_type',  p.type || 'percent');
  set('p_value', p.value || 0);
  set('p_min',   p.min_subtotal || 0);
  set('p_start', p.start || '');
  set('p_end',   p.end || '');
  set('p_active', (p.active ? 'Y':'N'));
  set('p_note',  p.note || '');
}
async function savePromo(){
  if (!byId('p_code')) return; // panel tidak ada
  var payload = {
    id: (function(){ var el=byId('p_id'); return el ? (el.value || undefined) : undefined; })(),
    code: (function(){ var el=byId('p_code'); return (el ? el.value : '').trim().toUpperCase(); })(),
    type: (function(){ var el=byId('p_type'); return el ? el.value : ''; })(),
    value: Number((function(){ var el=byId('p_value'); return el ? el.value : 0; })() || 0),
    min_subtotal: Number((function(){ var el=byId('p_min'); return el ? el.value : 0; })() || 0),
    start: (function(){ var el=byId('p_start'); return el ? (el.value || '') : ''; })(),
    end:   (function(){ var el=byId('p_end'); return el ? (el.value || '') : ''; })(),
    active: (function(){ var el=byId('p_active'); return el ? (el.value==='Y') : false; })(),
    note: (function(){ var el=byId('p_note'); return (el ? el.value : '').trim(); })()
  };
  if (!payload.code) { toast('Kode wajib diisi'); return; }
  if (!(payload.value>0)) { toast('Nilai promo harus > 0'); return; }

  var btn = byId('btnPromoSave'); setLoading(btn, true);
  var j = null;
  try { j = await Api.promoSave(payload); } catch(_){ j = { ok:false }; }
  setLoading(btn, false);
  if (!(j && j.ok)) { toast((j && j.error) || 'Gagal simpan promo'); return; }
  toast('Promo tersimpan');
  resetPromoForm();
  await loadPromos();
}
async function delPromo(id){
  var j = null;
  try { j = await Api.promoDel(id); } catch(_){ j = { ok:false }; }
  if (!(j && j.ok)) { toast((j && j.error) || 'Gagal hapus'); return; }
  toast('Promo terhapus');
  await loadPromos();
}

/* =====================
 * Bind UI events
 * ===================== */
function bindEvents(){
  // Main tabs
  var topTabs = document.querySelectorAll('.topnav .tab');
  for (var i=0;i<topTabs.length;i++){
    (function(btn){
      btn.addEventListener('click', function(){ setMainTab(btn.dataset.tab); });
    })(topTabs[i]);
  }

  // Search
  var qEl = byId('q');
  if (qEl){
    qEl.addEventListener('input', function(){
      var v = byId('q').value.trim();
      var clear = byId('btnClearSearch'); if (clear) clear.hidden = !v;
      renderBest(); renderMenu(); renderStrip();
    });
  }
  var btnClearSearch = byId('btnClearSearch');
  if (btnClearSearch){
    btnClearSearch.addEventListener('click', function(){
      var q = byId('q'); if (q) q.value='';
      var clear = byId('btnClearSearch'); if (clear) clear.hidden=true;
      renderBest(); renderMenu(); renderStrip();
    });
  }

  // Chips
  var chips = document.querySelector('.chips-scroll');
  if (chips){
    chips.addEventListener('click', function(e){
      var btn = e.target && e.target.closest ? e.target.closest('.chip') : null; if (!btn) return;
      setChipActive((btn.dataset && btn.dataset.cat) || '');
      renderBest(); renderMenu(); renderStrip();
    });
  }

  // Cart actions
  var btnEmpty = byId('btnEmptyCart');
  if (btnEmpty){
    btnEmpty.addEventListener('click', function(){
      if (confirm('Kosongkan keranjang?')) {
        State.cart = [];
        Store.save();
        renderCart();
      }
    });
  }

  // Checkout buttons (rate-limited)
  var btnCheckout       = byId('btnCheckout');
  var btnCheckoutBar    = byId('btnCheckoutBar');
  var btnCheckoutMobile = byId('btnCheckoutMobile');
  if (btnCheckout)       btnCheckout     .addEventListener('click', withLock(btnCheckout,       function(){ checkout(true); }));
  if (btnCheckoutBar)    btnCheckoutBar  .addEventListener('click', withLock(btnCheckoutBar,    function(){ checkout(false); }));
  if (btnCheckoutMobile) btnCheckoutMobile.addEventListener('click', withLock(btnCheckoutMobile, function(){ checkout(false); }));

  // Promo apply/clear (pakai fungsi dari cart.js)
  var btnPromo  = byId('btnPromo');
  var btnPromoM = byId('btnPromo_m');
  if (btnPromo)  btnPromo .addEventListener('click', withLock(btnPromo,  function(){ var el=byId('promo_code');   applyCoupon(el ? el.value : ''); }));
  if (btnPromoM) btnPromoM.addEventListener('click', withLock(btnPromoM, function(){ var el=byId('promo_code_m'); applyCoupon(el ? el.value : ''); }));

  var pill = byId('promoApplied');    if (pill) pill.addEventListener('click', clearCoupon);
  var clr1 = byId('btnPromoClear');   if (clr1) clr1.addEventListener('click', clearCoupon);
  var clr2 = byId('btnPromoClear_m'); if (clr2) clr2.addEventListener('click', clearCoupon);

  // Drawer (mobile)
  var bo = byId('btnOpenCart');     if (bo) bo.addEventListener('click', openDrawer);
  var bob= byId('btnOpenCartBar');  if (bob) bob.addEventListener('click', openDrawer);
  var bc = byId('btnCloseCart');    if (bc) bc.addEventListener('click', closeDrawer);
  var sc = byId('drawerScrim');     if (sc) sc.addEventListener('click', closeDrawer);

  // Admin gate → lempar event yang didengar admin.js
  var loginBtn = byId('btnAdminLogin');
  if (loginBtn){
    loginBtn.addEventListener('click', function(){
      var ev = new Event('adm:login');
      window.dispatchEvent(ev);
    });
  }

  // Admin subtabs
  var subBtns = document.querySelectorAll('.subtabs .subtab');
  for (var s=0;s<subBtns.length;s++){
    (function(btn){
      btn.addEventListener('click', function(){ setSubTab(btn.dataset.sub); });
    })(subBtns[s]);
  }

  // Admin: menu form
  var btnMenuSave  = byId('btnMenuSave');
  var btnMenuReset = byId('btnMenuReset');
  if (btnMenuSave)  btnMenuSave .addEventListener('click', function(){ window.dispatchEvent(new Event('adm:menu-save')); });
  if (btnMenuReset) btnMenuReset.addEventListener('click', function(){ window.dispatchEvent(new Event('adm:menu-reset')); });

  var mimg = byId('m_img');
  if (mimg){
    mimg.addEventListener('change', function(e){
      var f = e && e.target && e.target.files ? e.target.files[0] : null;
      if (f){
        window.dispatchEvent(new CustomEvent('adm:menu-preview', { detail: { blobUrl: URL.createObjectURL(f) }}));
      }
    });
  }
  var btnClearImg = byId('btnClearImg');
  if (btnClearImg){
    btnClearImg.addEventListener('click', function(){
      window.dispatchEvent(new Event('adm:menu-preview-clear'));
    });
  }

  // Admin: table actions (menu)
  var tblMenu = byId('tblMenu');
  if (tblMenu){
    tblMenu.addEventListener('click', function(e){
      var b = e.target && e.target.closest ? e.target.closest('button[data-action]') : null; if (!b) return;
      var id = b.dataset ? b.dataset.id : null;
      if (b.dataset.action === 'edit') window.dispatchEvent(new CustomEvent('adm:menu-edit', { detail:{ id: id } }));
      if (b.dataset.action === 'del'){
        if (confirm('Hapus item ini?')) window.dispatchEvent(new CustomEvent('adm:menu-del', { detail:{ id: id } }));
      }
    });
  }

  // Admin: category
  var btnCatSave = byId('btnCatSave');
  if (btnCatSave){
    btnCatSave.addEventListener('click', function(){ window.dispatchEvent(new Event('adm:cat-save')); });
  }
  var tblCat = byId('tblCat');
  if (tblCat){
    tblCat.addEventListener('click', function(e){
      var b = e.target && e.target.closest ? e.target.closest('button[data-cat-act]') : null; if (!b) return;
      var id = b.dataset ? b.dataset.id : null;
      if (b.dataset.catAct === 'edit'){
        var ev = new CustomEvent('adm:cat-edit', { detail:{ id: id } });
        window.dispatchEvent(ev);
      }
      if (b.dataset.catAct === 'del'){
        if (confirm('Hapus kategori ini?')) window.dispatchEvent(new CustomEvent('adm:cat-del', { detail:{ id: id } }));
      }
    });
  }

  // Admin: stock
  var btnStockSave = byId('btnStockSave');
  if (btnStockSave){
    btnStockSave.addEventListener('click', function(){ window.dispatchEvent(new Event('adm:stock-save')); });
  }

  // Admin: promo form (langsung panggil helper lokal)
  var btnPromoSave = byId('btnPromoSave');
  if (btnPromoSave) btnPromoSave.addEventListener('click', savePromo);
  var btnPromoReset = byId('btnPromoReset');
  if (btnPromoReset) btnPromoReset.addEventListener('click', resetPromoForm);

  var tblPromo = byId('tblPromo');
  if (tblPromo){
    tblPromo.addEventListener('click', function(e){
      var b = e.target && e.target.closest ? e.target.closest('button[data-pact]') : null; if (!b) return;
      var id = b.dataset ? b.dataset.id : null;
      if (b.dataset.pact === 'edit'){
        (async function(){
          var j = null;
          try { j = await Api.promoList(); } catch(_){ j = null; }
          var list = (j && j.data) ? j.data : [];
          var p = list.find(function(x){ return String(x.id)===String(id); });
          if (!p) {
            // fallback cari berdasarkan teks kode pada kolom pertama
            var tr = b.closest ? b.closest('tr') : null;
            var codeTxt = tr && tr.children && tr.children[0] ? String(tr.children[0].textContent || '').trim() : '';
            if (codeTxt) p = list.find(function(x){ return String(x.code).trim().toUpperCase() === codeTxt.toUpperCase(); });
          }
          if (p) fillPromoForm(p);
        })();
      }
      if (b.dataset.pact === 'del'){
        if (confirm('Hapus promo ini?')) delPromo(id);
      }
    });
  }

  // Dataset ready → admin.js akan merender tabel/dropdown; no-op di sini
  window.addEventListener('adm:dataset-ready', function(){});

  // Ketika admin menyimpan sesuatu → reload dengan overlay biar smooth
  window.addEventListener('adm:changed', function(){ reloadAll({ showLoading:true }); });
}

/* =====================
 * Utilities
 * ===================== */
function dedupeIds(list){
  for (var i=0;i<list.length;i++){
    var id = list[i];
    var nodes = document.querySelectorAll('#'+id);
    for (var j=0;j<nodes.length;j++){
      if (j>0) nodes[j].removeAttribute('id');
    }
  }
}

/* =====================
 * Reload all (cats + menu + tables + cart)
 * ===================== */
async function reloadAll(opts){
  opts = opts || {};
  var showLoading = !!opts.showLoading;
  try{
    if (showLoading) setPageLoading(true, {
      title: 'Menyiapkan toko…',
      tips: [
        'Mengambil data menu…',
        'Menyusun kategori…',
        'Memanaskan gambar…',
        'Menyiapkan checkout…',
        'Hampir selesai…'
      ]
    });

    // tampilkan skeleton di grid kalau belum ada data cache
    if (!(State.items && State.items.length)) showSkeleton(8);

    await loadCats();
    await loadMenu();
    validateCartAgainstStock();
    renderCart();
    if (byId('tblPromo')) await loadPromos();
  } catch (err){
    toast('Init error: ' + ((err && err.message) || err));
  } finally {
    if (showLoading) requestAnimationFrame(function(){ setPageLoading(false); });
  }
}

/* =====================
 * Init
 * ===================== */
(function init(){
  setMainTab('order');

  // buang id ganda agar byId() tidak ambigu (sesuaikan dgn markup kamu)
  dedupeIds(['cust_name_m','cust_phone_m','cust_addr_m','cust_note_m','promoApplied','mobileTotal']);

  addPreconnectHosts();       // preconnect host gambar
  Store.load();               // load persisted cart

  bindEvents();
  markRequiredInputs();
  togglePromoControls();

  // cache-first render (atau tampilkan skeleton jika cache kosong)
  loadFromCacheFast();

  // final reload dari network + tampilkan overlay spinner
  reloadAll({ showLoading:true });
})();
