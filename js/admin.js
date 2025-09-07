'use strict';
// Admin module: menu, category, stock, promo helpers + UX enhancements
// - ES2019-safe (tanpa optional chaining / nullish)
// - Emit CustomEvent('adm:changed') setelah perubahan agar main.js reload dataset
// - Listener event dari main.js (adm:login, adm:menu-*, adm:cat-*, dst)

import { byId, toast, setLoading, money, escapeHTML } from './utils.js';
import { State } from './state.js';
import { post } from './api.js';           // gunakan post() langsung agar bisa sisipkan admin_token
import { ADMIN_PIN } from './config.js';   // server cek isAdmin_(b) via Script Property ADMIN_TOKEN — samakan nilainya dgn ADMIN_PIN

/* =====================
 * POLYFILLS & HELPERS
 * ===================== */
// CustomEvent polyfill (Safari lama)
(function () {
  if (typeof window === 'undefined') return;
  try { new window.CustomEvent('test'); return; } catch (e) {}
  function CustomEvent(event, params) {
    params = params || { bubbles: false, cancelable: false, detail: null };
    var evt = document.createEvent('CustomEvent');
    evt.initCustomEvent(event, params.bubbles, params.cancelable, params.detail);
    return evt;
  }
  CustomEvent.prototype = window.Event.prototype;
  window.CustomEvent = CustomEvent;
})();

// Fallback CSS.escape
var cssEsc = (window.CSS && CSS.escape) ? window.CSS.escape : function (s) {
  return String(s).replace(/["\\]/g, '\\$&');
};

// Debounce sederhana
function debounce(fn, ms) {
  var t;
  return function () {
    var ctx = this, args = arguments;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(ctx, args); }, ms);
  };
}

// Int parser aman
function sanitizeInt(val) {
  var s = String(val == null ? '' : val);
  s = s.replace(/[^\d]/g, '');
  var n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

// LocalStorage kecil (try/catch utk private mode)
function lsGet(key, def) {
  try {
    var v = localStorage.getItem(key);
    return v == null ? def : JSON.parse(v);
  } catch (e) { return def; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

/* =====================
 * ADMIN TOKEN (FIX UNAUTHORIZED)
 * ===================== */
function getAdminToken() {
  // Pakai ADMIN_PIN sebagai admin_token untuk backend Apps Script (isAdmin_)
  // Pastikan Script Property ADMIN_TOKEN di server = ADMIN_PIN ini.
  return ADMIN_PIN || '';
}
function withAdminToken(obj) {
  obj = obj || {};
  obj.admin_token = getAdminToken();
  return obj;
}

/* =====================
 * IMAGE COMPRESS (CLIENT)
 * ===================== */
const IMG_MAX_W = 1200;
const IMG_MAX_H = 1200;
const IMG_MIME  = 'image/jpeg';
const IMG_QLTY  = 0.82;

function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
function loadImageFromDataURL(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = dataUrl;
  });
}
async function compressImageToDataURL(file) {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImageFromDataURL(dataUrl);

  let { width: w, height: h } = img;
  if (w <= IMG_MAX_W && h <= IMG_MAX_H) {
    const canvas0 = document.createElement('canvas');
    canvas0.width = w; canvas0.height = h;
    const ctx0 = canvas0.getContext('2d');
    ctx0.drawImage(img, 0, 0, w, h);
    return canvas0.toDataURL(IMG_MIME, IMG_QLTY);
  }

  const ratio = Math.min(IMG_MAX_W / w, IMG_MAX_H / h);
  const nw = Math.max(1, Math.round(w * ratio));
  const nh = Math.max(1, Math.round(h * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = nw; canvas.height = nh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, nw, nh);
  return canvas.toDataURL(IMG_MIME, IMG_QLTY);
}

/* =====================
 * STATE (local UI)
 * ===================== */
var LS_KEY_FILTER = 'adm_menu_filter';
var LS_KEY_SORT   = 'adm_menu_sort';

var MENU_FILTER = lsGet(LS_KEY_FILTER, '');
var MENU_SORT   = lsGet(LS_KEY_SORT, { key: 'name', dir: 1 }); // dir: 1 asc, -1 desc
var _editingRowId = null;

/* =====================
 * GATE / AUTH (PIN)
 * ===================== */
function wirePinEnterOnce() {
  var pinEl = byId('pin');
  if (pinEl && !pinEl.dataset.keybound) {
    pinEl.dataset.keybound = '1';
    pinEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') adminLogin();
    });
  }
}

export function adminLogin() {
  var pinEl = byId('pin');
  var ok = (pinEl && pinEl.value ? pinEl.value : '') === ADMIN_PIN;
  if (!ok) {
    toast('PIN salah');
    wirePinEnterOnce();
    return;
  }

  var gate = byId('adminGate'); if (gate) gate.classList.add('hidden');
  var panel = byId('adminPanel'); if (panel) panel.classList.remove('hidden');

  // fokus subtab pertama (menu)
  var firstTab = document.querySelector('.subtabs .subtab[data-sub="menu"]');
  if (firstTab) firstTab.click();

  // Pastikan UX panel ter-wire
  wireAdminUX();
}

// Wire PIN enter di awal
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wirePinEnterOnce);
} else {
  wirePinEnterOnce();
}

/* =====================
 * MENU CRUD
 * ===================== */
export function clearPreview() {
  var img = byId('m_prev');
  if (img) { img.src = ''; img.classList.add('hidden'); }
  var b = byId('btnClearImg'); if (b) b.classList.add('hidden');
  var iu = byId('m_image_url'); if (iu) iu.value = '';
  var im = byId('m_img'); if (im) im.value = '';
}
export function showPreview(url) {
  var img = byId('m_prev'); if (!img) return;
  img.src = url; img.classList.remove('hidden');
  var b = byId('btnClearImg'); if (b) b.classList.remove('hidden');
}
export function resetMenuForm() {
  var ids = ['m_id', 'm_name', 'm_price', 'm_stock'];
  for (var i = 0; i < ids.length; i++) {
    var el = byId(ids[i]); if (el) el.value = '';
  }
  var act = byId('m_active'); if (act) act.value = 'Y';
  var iu = byId('m_image_url'); if (iu) iu.value = '';
  var cs = byId('m_cat'); if (cs) cs.value = (State.cats[0] && State.cats[0].name) ? State.cats[0].name : '';
  clearPreview();
  _editingRowId = null;
  var btn = byId('btnMenuSave'); if (btn) btn.textContent = 'Simpan';
  var nm = byId('m_name'); if (nm) nm.focus();
  updatePricePreview();
  var trs = document.querySelectorAll('#tblMenu tbody tr.is-editing');
  for (var j = 0; j < trs.length; j++) trs[j].classList.remove('is-editing');
}

function filteredSortedItems() {
  var list = (State.itemsAdmin || []).slice();

  // filter
  var q = (MENU_FILTER || '').trim().toLowerCase();
  if (q) {
    list = list.filter(function (m) {
      var name = String(m.name || '').toLowerCase();
      var cat = String(m.category || m.kategori || m.category_name || '').toLowerCase();
      return name.indexOf(q) !== -1 || cat.indexOf(q) !== -1;
    });
  }

  // sort
  var key = MENU_SORT.key, dir = MENU_SORT.dir;
  list.sort(function (a, b) {
    var va, vb;
    if (key === 'price' || key === 'stock') {
      va = Number(a[key] || 0); vb = Number(b[key] || 0);
    } else if (key === 'active') {
      va = a.active ? 1 : 0; vb = b.active ? 1 : 0;
    } else if (key === 'category') {
      va = String(a.category || a.kategori || a.category_name || '').toLowerCase();
      vb = String(b.category || b.kategori || b.category_name || '').toLowerCase();
    } else {
      va = String(a.name || '').toLowerCase();
      vb = String(b.name || '').toLowerCase();
    }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });

  return list;
}

function ensureMenuToolsUI() {
  var table = byId('tblMenu'); if (!table) return;
  var wrap = table.closest ? table.closest('.table-wrap') : null;
  if (!wrap) wrap = table.parentElement;
  if (!wrap) return;

  // toolbar di atas tabel (search + hint sort)
  if (!byId('m_filter')) {
    var tools = document.createElement('div');
    tools.className = 'table-tools';
    tools.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:space-between;margin:6px 0';
    tools.innerHTML = '' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '  <input id="m_filter" placeholder="Cari menu/kategori…" style="max-width:220px;padding:.4rem .6rem;border:1px solid #e5e7eb;border-radius:.5rem"/>' +
      '  <small class="muted" id="m_count"></small>' +
      '</div>' +
      '<small class="muted">Klik header tabel untuk sortir • Status <b>Aktif</b> ubah via tombol <b>Edit</b></small>';

    if (wrap.parentElement) wrap.parentElement.insertBefore(tools, wrap);

    var f = byId('m_filter');
    if (f) {
      f.value = MENU_FILTER || '';
      f.addEventListener('input', debounce(function () {
        MENU_FILTER = f.value || '';
        lsSet(LS_KEY_FILTER, MENU_FILTER);
        renderAdminTables();
      }, 120));
    }
  }
}

function paintSortIndicator() {
  var table = byId('tblMenu'); if (!table) return;
  var thead = table.querySelector('thead'); if (!thead) return;
  var ths = thead.querySelectorAll('th');
  for (var i = 0; i < ths.length; i++) {
    ths[i].classList.remove('sort-asc', 'sort-desc');
    var map = { 0: 'name', 1: 'category', 2: 'price', 3: 'stock', 4: 'active' };
    var key = map[i];
    if (key && key === MENU_SORT.key) {
      ths[i].classList.add(MENU_SORT.dir === 1 ? 'sort-asc' : 'sort-desc');
    }
  }
}

function ensureMenuHeaderSort() {
  var table = byId('tblMenu'); if (!table) return;
  var thead = table.querySelector('thead'); if (!thead) return;

  if (thead.dataset && thead.dataset.sorted) return;
  if (thead.dataset) thead.dataset.sorted = '1';

  thead.addEventListener('click', function (e) {
    var th = (e.target && e.target.closest) ? e.target.closest('th') : null; if (!th) return;
    var idx = Array.prototype.indexOf.call(th.parentElement.children, th);
    var map = { 0: 'name', 1: 'category', 2: 'price', 3: 'stock', 4: 'active' };
    var key = map[idx];
    if (!key) return;

    if (MENU_SORT.key === key) {
      MENU_SORT.dir = -MENU_SORT.dir;
    } else {
      MENU_SORT.key = key; MENU_SORT.dir = 1;
    }
    lsSet(LS_KEY_SORT, MENU_SORT);
    renderAdminTables();
  });
}

export function renderAdminTables() {
  // Dropdown kategori di form menu
  var catSel = byId('m_cat');
  if (catSel) {
    var cats = (State.cats || []).slice().sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name));
    });
    catSel.innerHTML = cats.map(function (c) {
      return '<option>' + escapeHTML(c.name) + '</option>';
    }).join('');
  }

  ensureMenuToolsUI();
  ensureMenuHeaderSort();

  // Tabel menu
  var table = byId('tblMenu'); if (!table) return;
  var tb = table.querySelector('tbody'); if (!tb) return;

  var list = filteredSortedItems();

  // hitung & tampilkan jumlah
  var countEl = byId('m_count');
  if (countEl) countEl.textContent = list.length ? (String(list.length) + ' item') : '0 item';

  tb.innerHTML = '';
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="6" class="muted">Belum ada data</td></tr>';
    paintSortIndicator();
    return;
  }

  var rowsHTML = [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    var kat = m.category || m.kategori || m.category_name || '-';
    rowsHTML.push(
      '<tr data-id="' + escapeHTML(String(m.id)) + '"' + (_editingRowId && String(_editingRowId) === String(m.id) ? ' class="is-editing"' : '') + '>' +
      '  <td>' + escapeHTML(m.name) + '</td>' +
      '  <td>' + escapeHTML(kat) + '</td>' +
      '  <td class="right">' + money(m.price) + '</td>' +
      '  <td class="right">' + String(m.stock) + '</td>' +
      // <<< NONAKTIFKAN quick-toggle: hilangkan class & pointer
      '  <td class="center">' + (m.active ? 'Y' : 'N') + '</td>' +
      '  <td class="center">' +
      '    <button class="btn btn--ghost" data-action="edit" data-id="' + escapeHTML(String(m.id)) + '">Edit</button>' +
      '    <button class="btn btn--ghost danger" data-action="del" data-id="' + escapeHTML(String(m.id)) + '">Hapus</button>' +
      '  </td>' +
      '</tr>'
    );
  }
  tb.innerHTML = rowsHTML.join('');

  // Delegasi event sekali saja
  if (!tb.dataset.bound) {
    tb.dataset.bound = '1';
    tb.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;

      // (quick-active dihapus)

      // tombol edit/hapus
      var btn = (t.getAttribute && t.getAttribute('data-action')) ? t : (t.closest ? t.closest('[data-action]') : null);
      if (btn) {
        var act = btn.getAttribute('data-action');
        var id3 = btn.getAttribute('data-id');
        if (act === 'edit') editMenu(id3);
        else if (act === 'del') delMenu(id3);
      }
    });
  }

  paintSortIndicator();
}

// (quickToggleActive dihapus)

/* ======= Price preview ======= */
function updatePricePreview() {
  var inp = byId('m_price'); if (!inp) return;
  var lab = byId('m_price_lbl');
  if (!lab) {
    lab = document.createElement('small');
    lab.id = 'm_price_lbl';
    lab.className = 'muted';
    lab.style.marginLeft = '6px';
    var field = inp.closest ? inp.closest('.field') : null;
    if (field) {
      var span = field.querySelector('span');
      if (span) span.appendChild(lab);
      else field.appendChild(lab);
    } else if (inp.parentNode) {
      inp.parentNode.appendChild(lab);
    }
  }
  var v = sanitizeInt(inp.value);
  lab.textContent = v ? ('≈ ' + money(v)) : '';
}

export async function saveMenu() {
  // 1) ambil input
  var image_url = (function () {
    var el = byId('m_image_url'); return el ? (el.value || '') : '';
  })();
  var fileEl = byId('m_img');
  var f = (fileEl && fileEl.files && fileEl.files[0]) ? fileEl.files[0] : null;

  // 2) upload foto (terkompres)
  if (f) {
    var okTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (okTypes.indexOf(f.type) === -1) { toast('Format gambar harus JPG/PNG/WebP/GIF'); return; }
    if (f.size > 7 * 1024 * 1024) { toast('Ukuran foto mentah > 7MB. Pilih foto lain.'); return; }

    let data_url;
    try {
      data_url = await compressImageToDataURL(f);   // JPEG 0.82, max 1200px
    } catch (e) {
      data_url = await readFileAsDataURL(f);        // fallback
    }

    var upBtn = byId('btnMenuSave'); setLoading(upBtn, true);
    let up;
    try {
      up = await post('upload-image', withAdminToken({ data_url, name: f.name || ('img-' + Date.now() + '.jpg') }), true);
    } catch (e) { up = { ok: false, error: String(e && e.message || e) }; }
    setLoading(upBtn, false);

    if (!up || !up.ok) {
      toast('Upload foto gagal' + (up && up.error ? (': ' + up.error) : ''));
      return;
    }
    image_url = up.url;
    var iu = byId('m_image_url'); if (iu) iu.value = image_url;
  }

  // 3) payload simpan menu
  var payload = {
    id: (function () { var el = byId('m_id'); return el ? (el.value || undefined) : undefined; })(),
    name: (function () { var el = byId('m_name'); return (el ? el.value : '').trim(); })(),
    category: (function () { var el = byId('m_cat'); return (el ? el.value : '').trim(); })(),
    price: Math.max(0, sanitizeInt((function () { var el = byId('m_price'); return el ? el.value : 0; })())),
    stock: Math.max(0, sanitizeInt((function () { var el = byId('m_stock'); return el ? el.value : 0; })())),
    active: (function () { var el = byId('m_active'); return el ? (el.value === 'Y') : false; })(),
    image_url: image_url
  };
  if (!payload.name) { toast('Nama menu wajib diisi'); return; }
  payload = withAdminToken(payload);

  // 4) simpan
  var btn = byId('btnMenuSave'); setLoading(btn, true);
  let j2;
  try { j2 = await post('menu-save', payload, true); }
  catch (e2) { j2 = { ok: false, error: String(e2 && e2.message || e2) }; }
  setLoading(btn, false);

  if (!j2 || !j2.ok) {
    const msg = (j2 && j2.error) || 'Gagal simpan';
    toast(msg);
    if (/unauthorized/i.test(String(msg))) {
      toast('Cek: ADMIN_TOKEN (server) harus sama dengan ADMIN_PIN (config.js)');
    }
    return;
  }
  toast('Menu tersimpan');
  resetMenuForm();
  window.dispatchEvent(new CustomEvent('adm:changed', { detail: { scope: 'menu' } }));
}

export async function delMenu(id) {
  if (!id) return;
  if (!window.confirm('Hapus menu ini?')) return;
  let j;
  try { j = await post('menu-del', withAdminToken({ id: id }), true); }
  catch (e) { j = { ok: false, error: String(e && e.message || e) }; }
  if (!j || !j.ok) { toast((j && j.error) || 'Gagal hapus'); return; }
  toast('Terhapus');
  window.dispatchEvent(new CustomEvent('adm:changed', { detail: { scope: 'menu' } }));
}

export function editMenu(id) {
  var m = (State.itemsAdmin || []).find(function (x) { return String(x.id) === String(id); });
  if (!m) return;

  _editingRowId = id;

  var el;
  el = byId('m_id'); if (el) el.value = m.id || '';
  el = byId('m_name'); if (el) el.value = m.name || '';
  el = byId('m_price'); if (el) el.value = Number(m.price || 0);
  el = byId('m_stock'); if (el) el.value = Number(m.stock || 0);
  el = byId('m_active'); if (el) el.value = m.active ? 'Y' : 'N';
  el = byId('m_image_url'); if (el) el.value = m.image_url || '';

  var sel = byId('m_cat');
  if (sel) {
    var want = String(m.category || m.kategori || m.category_name || '').trim();
    var has = false;
    for (var i = 0; i < sel.options.length; i++) { if (sel.options[i].value === want) { has = true; break; } }
    if (want && !has) sel.add(new Option(want, want));
    sel.value = want || ((State.cats[0] && State.cats[0].name) ? State.cats[0].name : '');
  }

  if (m.image_url) showPreview(m.image_url); else clearPreview();
  updatePricePreview();

  var btn = byId('btnMenuSave'); if (btn) btn.textContent = 'Update Menu';

  var all = document.querySelectorAll('#tblMenu tbody tr');
  for (var k = 0; k < all.length; k++) {
    var tr = all[k];
    tr.classList.toggle('is-editing', tr.getAttribute('data-id') === String(id));
  }

  var nm = byId('m_name'); if (nm) nm.focus();

  var formCard = null;
  var sub = byId('sub-menu');
  if (sub) {
    var f = sub.querySelector ? sub.querySelector('.form') : null;
    var grid = f && f.closest ? f.closest('.grid--2cols') : null;
    formCard = grid || sub;
  }
  if (formCard && formCard.scrollIntoView) formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* =====================
 * CATEGORY CRUD
 * ===================== */
export function renderCatTable() {
  var table = byId('tblCat'); if (!table) return;
  var tb = table.querySelector('tbody'); if (!tb) return;
  tb.innerHTML = '';
  if (!(State.cats || []).length) {
    tb.innerHTML = '<tr><td colspan="2" class="muted">Belum ada data</td></tr>';
    return;
  }
  var list = (State.cats || []).slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  var html = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    html.push(
      '<tr>' +
      '  <td>' + escapeHTML(c.name) + '</td>' +
      '  <td class="center">' +
      '    <button class="btn btn--ghost" data-cat-act="edit" data-id="' + escapeHTML(String(c.id)) + '">Edit</button>' +
      '    <button class="btn btn--ghost danger" data-cat-act="del" data-id="' + escapeHTML(String(c.id)) + '">Hapus</button>' +
      '  </td>' +
      '</tr>'
    );
  }
  tb.innerHTML = html.join('');

  if (!tb.dataset.bound) {
    tb.dataset.bound = '1';
    tb.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;
      var btn = (t.getAttribute && t.getAttribute('data-cat-act')) ? t : (t.closest ? t.closest('[data-cat-act]') : null);
      if (!btn) return;
      var act = btn.getAttribute('data-cat-act');
      var id = btn.getAttribute('data-id');
      if (act === 'edit') {
        var c = (State.cats || []).find(function (x) { return String(x.id) === String(id); });
        if (c) {
          var idEl = byId('c_id'); if (idEl) idEl.value = c.id;
          var nmEl = byId('c_name'); if (nmEl) nmEl.value = c.name;
          if (nmEl) nmEl.focus();
        }
      } else if (act === 'del') {
        delCat(id);
      }
    });
  }
}
export function resetCatForm() {
  var idEl = byId('c_id'); if (idEl) idEl.value = '';
  var nmEl = byId('c_name'); if (nmEl) { nmEl.value = ''; nmEl.focus(); }
}
export async function saveCat() {
  var payload = {
    id: (function () { var el = byId('c_id'); return el ? (el.value || undefined) : undefined; })(),
    name: (function () { var el = byId('c_name'); return (el ? el.value : '').trim(); })()
  };
  if (!payload.name) { toast('Nama kategori wajib diisi'); return; }
  payload = withAdminToken(payload);

  var btn = byId('btnCatSave'); setLoading(btn, true);
  var j;
  try { j = await post('cat-save', payload, true); }
  catch (e) { j = { ok: false }; }
  setLoading(btn, false);

  if (!j || !j.ok) { toast((j && j.error) || 'Gagal simpan'); return; }
  toast('Kategori tersimpan');
  resetCatForm();
  window.dispatchEvent(new CustomEvent('adm:changed', { detail: { scope: 'category' } }));
}
export async function delCat(id) {
  if (!id) return;
  if (!window.confirm('Hapus kategori ini?')) return;
  var j;
  try { j = await post('cat-del', withAdminToken({ id: id }), true); }
  catch (e) { j = { ok: false }; }
  if (!j || !j.ok) { toast((j && j.error) || 'Gagal hapus'); return; }
  toast('Terhapus');
  window.dispatchEvent(new CustomEvent('adm:changed', { detail: { scope: 'category' } }));
}

/* =====================
 * STOCK ADJUSTMENT
 * ===================== */
export function renderStockDropdown() {
  var sel = byId('s_item'); if (!sel) return;
  var items = (State.itemsAdmin || []).map(function (m) {
    return '<option value="' + escapeHTML(String(m.id)) + '">' + escapeHTML(m.name) + ' — stok ' + String(m.stock) + '</option>';
  });
  sel.innerHTML = items.join('');
}
export async function saveStock() {
  var sItem = byId('s_item');
  var sDelta = byId('s_delta');
  var sNote = byId('s_note');
  var item_id = sItem ? sItem.value : '';
  var delta = sDelta ? Number(sDelta.value || 0) : 0;
  var note = sNote && sNote.value ? sNote.value.trim() : '';
  if (!item_id || !delta) { toast('Pilih item & isi delta'); return; }

  var btn = byId('btnStockSave'); setLoading(btn, true);
  var j;
  try { j = await post('stock-adjust', withAdminToken({ item_id: item_id, delta: delta, note: note }), true); }
  catch (e) { j = { ok: false }; }
  setLoading(btn, false);

  if (!j || !j.ok) { toast((j && j.error) || 'Gagal update stok'); return; }
  toast('Stok diperbarui');
  window.dispatchEvent(new CustomEvent('adm:changed', { detail: { scope: 'stock' } }));
}

/* =====================
 * PROMO (table render + UX)
 * ===================== */
export function renderPromoTable(promos) {
  var tbl = byId('tblPromo'); if (!tbl) return;
  var tb = tbl.querySelector('tbody'); if (!tb) return;
  tb.innerHTML = '';
  if (!(promos && promos.length)) {
    tb.innerHTML = '<tr><td colspan="7" class="muted">Belum ada promo</td></tr>';
    return;
  }
  var list = promos.slice().sort(function (a, b) { return String(a.code).localeCompare(String(b.code)); });
  var html = [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    var start = p.start || ''; var end = p.end || '';
    var periode = (start || end) ? (start || '—') + ' → ' + (end || '—') : '-';
    html.push(
      '<tr data-id="' + escapeHTML(String(p.id)) + '">' +
      '  <td>' + escapeHTML(p.code) + '</td>' +
      '  <td>' + (p.type === 'percent' ? '%' : 'Rp') + '</td>' +
      '  <td class="right">' + (p.type === 'percent' ? (String(p.value) + '%') : money(p.value)) + '</td>' +
      '  <td class="right">' + (p.min_subtotal ? money(p.min_subtotal) : '-') + '</td>' +
      '  <td>' + periode + '</td>' +
      '  <td class="center promo-active" style="cursor:pointer" title="Klik untuk toggle aktif">' + (p.active ? 'Y' : 'N') + '</td>' +
      '  <td class="center">' +
      '    <button class="btn btn--ghost" data-pact="edit" data-id="' + escapeHTML(String(p.id)) + '">Edit</button>' +
      '    <button class="btn btn--ghost danger" data-pact="del" data-id="' + escapeHTML(String(p.id)) + '">Hapus</button>' +
      '  </td>' +
      '</tr>'
    );
  }
  tb.innerHTML = html.join('');

  if (!tb.dataset.bound) {
    tb.dataset.bound = '1';
    // click
    tb.addEventListener('click', function (e) {
      var t = e.target; if (!t) return;

      // toggle aktif
      var pa = (t.classList && t.classList.contains('promo-active')) ? t : (t.closest ? t.closest('.promo-active') : null);
      if (pa) {
        var tr = t.closest ? t.closest('tr') : null;
        var id = tr ? tr.getAttribute('data-id') : null;
        if (id) {
          var p = (promos || []).find(function (x) { return String(x.id) === String(id); });
          if (p) quickTogglePromoActive(p);
        }
        return;
      }

      // tombol edit/del
      var btn = (t.getAttribute && t.getAttribute('data-pact')) ? t : (t.closest ? t.closest('[data-pact]') : null);
      if (btn) {
        var act = btn.getAttribute('data-pact');
        var id2 = btn.getAttribute('data-id');
        if (act === 'edit') {
          var p2 = (promos || []).find(function (x) { return String(x.id) === String(id2); });
          if (p2) fillPromoForm(p2);
        } else if (act === 'del') {
          delPromo(id2);
        }
      }
    });
  }

  ensurePromoUX();
}

async function quickTogglePromoActive(p) {
  var payload = {};
  for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) payload[k] = p[k];
  payload.active = !p.active;
  payload = withAdminToken(payload);

  var tbl = byId('tblPromo');
  var cell = tbl ? tbl.querySelector('tr[data-id="' + cssEsc(String(p.id)) + '"] .promo-active') : null;
  if (cell) cell.textContent = payload.active ? 'Y' : 'N';

  var j;
  try { j = await post('promo-save', payload, true); }
  catch (e) { j = { ok: false }; }
  if (!j || !j.ok) {
    toast('Gagal toggle promo');
    if (cell) cell.textContent = p.active ? 'Y' : 'N';
    return;
  }
  window.dispatchEvent(new CustomEvent('adm:changed', { detail: { scope: 'promo' } }));
}

function ensurePromoUX() {
  var code = byId('p_code');
  var type = byId('p_type');
  var val = byId('p_value');

  if (code && !code.dataset.bound) {
    code.dataset.bound = '1';
    code.addEventListener('input', function () {
      var v = (code.value || '').toUpperCase().replace(/\s+/g, '');
      if (code.value !== v) code.value = v;
    });
  }

  if (type && !type.dataset.bound) {
    type.dataset.bound = '1';
    type.addEventListener('change', function () {
      if (!val) return;
      if (type.value === 'percent') { val.placeholder = '1..100'; }
      else { val.placeholder = '5000'; }
    });
  }
}

/* =====================
 * SAVE PROMO + VALIDASI
 * ===================== */
function validatePromoPeriod(start, end) {
  if (!start || !end) return true;
  try {
    var s = new Date(start + 'T00:00:00');
    var e = new Date(end + 'T23:59:59');
    return e >= s;
  } catch (e) { return true; }
}

async function savePromoInternal() {
  var pCode = byId('p_code'); if (!pCode) return; // panel tidak ada
  var payload = {
    id: (function () { var el = byId('p_id'); return el ? (el.value || undefined) : undefined; })(),
    code: (pCode.value || '').trim().toUpperCase(),
    type: (function () { var el = byId('p_type'); return el ? el.value : ''; })(),
    value: Number((function () { var el = byId('p_value'); return el ? el.value : 0; })() || 0),
    min_subtotal: Number((function () { var el = byId('p_min'); return el ? el.value : 0; })() || 0),
    start: (function () { var el = byId('p_start'); return el ? (el.value || '') : ''; })(),
    end: (function () { var el = byId('p_end'); return el ? (el.value || '') : ''; })(),
    active: (function () { var el = byId('p_active'); return el ? (el.value === 'Y') : false; })(),
    note: (function () { var el = byId('p_note'); return (el ? el.value : '').trim(); })()
  };
  if (!payload.code) { toast('Kode wajib diisi'); return; }
  if (!(payload.value > 0)) { toast('Nilai promo harus > 0'); return; }
  if (!validatePromoPeriod(payload.start, payload.end)) { toast('Periode tidak valid (akhir < mulai)'); return; }
  payload = withAdminToken(payload);

  var btn = byId('btnPromoSave'); setLoading(btn, true);
  var j;
  try { j = await post('promo-save', payload, true); }
  catch (e) { j = { ok: false }; }
  setLoading(btn, false);
  if (!j || !j.ok) { toast((j && j.error) || 'Gagal simpan promo'); return; }
  toast('Promo tersimpan');
  resetPromoForm();
  window.dispatchEvent(new CustomEvent('adm:changed', { detail: { scope: 'promo' } }));
}

// expose agar kompatibel dgn main.js yang memanggil savePromo()
export async function savePromo() { return savePromoInternal(); }
export async function delPromo(id) {
  if (!id) return;
  if (!window.confirm('Hapus promo ini?')) return;
  var j;
  try { j = await post('promo-del', withAdminToken({ id }), true); }
  catch (e) { j = { ok: false }; }
  if (!j || !j.ok) { toast((j && j.error) || 'Gagal hapus'); return; }
  toast('Promo terhapus');
  window.dispatchEvent(new CustomEvent('adm:changed', { detail: { scope: 'promo' } }));
}
export function fillPromoForm(p) {
  var el;
  el = byId('p_id'); if (el) el.value = p.id || '';
  el = byId('p_code'); if (el) el.value = (p.code || '').toUpperCase();
  el = byId('p_type'); if (el) el.value = p.type || 'percent';
  el = byId('p_value'); if (el) el.value = p.value || 0;
  el = byId('p_min'); if (el) el.value = p.min_subtotal || 0;
  el = byId('p_start'); if (el) el.value = p.start || '';
  el = byId('p_end'); if (el) el.value = p.end || '';
  el = byId('p_active'); if (el) el.value = (p.active ? 'Y' : 'N');
  el = byId('p_note'); if (el) el.value = p.note || '';
}

/* =====================
 * EVENT WIRING (dari main.js)
 * ===================== */
// Login
window.addEventListener('adm:login', function () { adminLogin(); });

// Dataset siap dari network → render tabel & dropdown admin
window.addEventListener('adm:dataset-ready', function () {
  renderAdminTables();
  renderStockDropdown();
  renderCatTable();
  ensurePromoUX();
});

// Promo list dikirim dari main.js
window.addEventListener('adm:promos', function (e) {
  var promos = e && e.detail && e.detail.promos ? e.detail.promos : [];
  renderPromoTable(promos);
});

// Menu events
window.addEventListener('adm:menu-save', function () { saveMenu(); });
window.addEventListener('adm:menu-reset', function () { resetMenuForm(); });
window.addEventListener('adm:menu-preview', function (e) {
  var url = e && e.detail ? e.detail.blobUrl : '';
  if (url) showPreview(url);
});
window.addEventListener('adm:menu-preview-clear', function () { clearPreview(); });
window.addEventListener('adm:menu-edit', function (e) {
  var id = e && e.detail ? e.detail.id : '';
  if (id) editMenu(id);
});
window.addEventListener('adm:menu-del', function (e) {
  var id = e && e.detail ? e.detail.id : '';
  if (id) delMenu(id);
});

// Category events
window.addEventListener('adm:cat-save', function () { saveCat(); });
window.addEventListener('adm:cat-edit', function (e) {
  var id = e && e.detail ? e.detail.id : '';
  var c = (State.cats || []).find(function (x) { return String(x.id) === String(id); });
  if (c) {
    var idEl = byId('c_id'); if (idEl) idEl.value = c.id;
    var nmEl = byId('c_name'); if (nmEl) nmEl.value = c.name;
    if (nmEl) nmEl.focus();
  }
});
window.addEventListener('adm:cat-del', function (e) {
  var id = e && e.detail ? e.detail.id : '';
  if (id) delCat(id);
});

// Stock event
window.addEventListener('adm:stock-save', function () { saveStock(); });

/* =====================
 * Admin UX wiring (form behaviors)
 * ===================== */
function wireAdminUX() {
  // Enter untuk save (kecuali file/textarea)
  var formWrap = byId('sub-menu');
  var form = formWrap && formWrap.querySelector ? formWrap.querySelector('.form') : null;
  if (form && !form.dataset.keybound) {
    form.dataset.keybound = '1';
    form.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
      var isEnter = (e.key === 'Enter');
      var isCtrlEnter = isEnter && (e.ctrlKey || e.metaKey);
      var isTextual = (tag === 'textarea' || tag === 'select' || tag === 'button' || (tag === 'input' && (e.target && e.target.type === 'file')));

      if ((isEnter && !isTextual) || isCtrlEnter) {
        e.preventDefault();
        saveMenu();
      }
    });

    var priceEl = byId('m_price');
    if (priceEl) {
      priceEl.addEventListener('input', function () {
        var el = byId('m_price'); if (!el) return;
        var v = sanitizeInt(el.value);
        if (String(v) !== String(el.value)) el.value = v;
        updatePricePreview();
      });
      // initial preview
      updatePricePreview();
    }
  }

  // Persisted sort/filter ke UI (jika input sudah ada)
  var f = byId('m_filter'); if (f && f.value !== (MENU_FILTER || '')) f.value = MENU_FILTER || '';
}
