'use strict';
// Utils: DOM helpers, formatting, toast, spinner, rate-limit click (ES2019-safe)

/* =============== DOM Helpers =============== */
var $  = function(sel, parent){ return (parent || document).querySelector(sel); };
var $$ = function(sel, parent){ return Array.prototype.slice.call((parent || document).querySelectorAll(sel)); };
var byId = function(id){ return document.getElementById(id); };

function _resolveEl(elOrId){
  if (!elOrId) return null;
  if (typeof elOrId === 'string') return byId(elOrId);
  return elOrId; // assume HTMLElement
}

/* =============== Text & State Helpers =============== */
function setText(id, txt){
  var el = _resolveEl(id);
  if (el) el.textContent = (txt == null ? '' : String(txt));
}
function setDisabled(id, v){
  var el = _resolveEl(id);
  if (el) el.disabled = !!v;
}

/* =============== Number/Money =============== */
var fmtIDR;
try {
  fmtIDR = new Intl.NumberFormat('id-ID');
} catch (e) {
  // Fallback: simple thousand separator with dot
  fmtIDR = { format: function(n){ 
    var s = String(Math.floor(Math.abs(Number(n) || 0)));
    return (s.replace(/\B(?=(\d{3})+(?!\d))/g, '.'));
  }};
}
function money(n){
  var v = Number(n || 0);
  try { return 'Rp' + fmtIDR.format(v); }
  catch(_){ return 'Rp' + (v.toFixed(0)); }
}

/* =============== Escaping =============== */
function escapeHTML(s){
  var str = String(s == null ? '' : s);
  return str.replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);
  });
}

/* =============== Toast (snackbar) =============== */
var _toastTimer = null;
function toast(msg, ms){
  if (ms == null) ms = 2200;
  var sb = byId('snackbar');
  if (!sb) { try{ console.warn('Toast:', msg); }catch(_){}
    return;
  }
  // Ensure ARIA live region
  sb.setAttribute('role','status');
  sb.setAttribute('aria-live','polite');

  // reset animation state
  sb.classList.remove('show');
  // slight reflow to restart CSS animation if any
  void sb.offsetWidth;

  sb.textContent = String(msg == null ? '' : msg);
  sb.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function(){ sb.classList.remove('show'); }, ms);
}

/* =============== Loading (spinner kecil di tombol) =============== */
function setLoading(elOrId, v){
  var el = _resolveEl(elOrId);
  if (!el) return;
  if (v){
    if (!el.dataset.oldHtml) el.dataset.oldHtml = el.innerHTML;
    el.classList.add('is-loading');
    el.disabled = true;
    var label = (el.textContent || '...');
    label = (label && label.trim) ? label.trim() : '...';
    el.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>' + escapeHTML(label) + '</span>';
  } else {
    el.classList.remove('is-loading');
    el.disabled = false;
    if (el.dataset.oldHtml != null){
      el.innerHTML = el.dataset.oldHtml;
      delete el.dataset.oldHtml;
    }
  }
}

/* =============== Rate-limit aksi tombol (anti spam) =============== */
function withLock(btnElOrId, fn, cooldown){
  if (cooldown == null) cooldown = 350;
  var locked = false, last = 0;
  var btn = _resolveEl(btnElOrId);
  return async function(){
    var now = Date.now();
    if (locked || (now - last) < cooldown) return;
    locked = true; last = now;
    if (btn) setLoading(btn, true);
    try {
      return await fn.apply(this, arguments);
    } finally {
      if (btn) setLoading(btn, false);
      locked = false;
    }
  };
}

/* =============== Badge count sinkronisasi =============== */
function updateCartBadges(count){
  var txt = String(count == null ? 0 : count);
  setText('cartCount', txt);
  setText('cartCountBar', txt);
  var nodes = $$('[data-cart-count]');
  for (var i=0;i<nodes.length;i++){ nodes[i].textContent = txt; }
}

/* =============== Exports dasar =============== */
export {
  $, $$, byId,
  setText, setDisabled,
  money, escapeHTML,
  toast,
  setLoading, withLock,
  updateCartBadges,
};

/* ===== Page loading overlay (keren + tips berganti + progress bar) =====
 * HTML yang diharapkan:
 * <div id="pageLoading" class="pageload">
 *   <div class="pl__box">
 *     <div class="pl__ring"></div>
 *     <div class="pl__text">
 *       <div id="plText" class="pl__title">Menyiapkan toko…</div>
 *       <div class="pl__bar"><span></span></div>
 *       <div id="plTips" class="pl__tips">Mengambil data menu…</div>
 *     </div>
 *   </div>
 * </div>
 */
var _plTimer = null;
var _plIdx = 0;
var _plBarTimer = null;

var DEFAULT_TIPS = [
  'Mengambil data menu…',
  'Menyusun kategori…',
  'Memanaskan gambar…',
  'Menyiapkan checkout…',
  'Hampir selesai…'
];

/**
 * setPageLoading(true, { title?:string, tips?:string[] })
 * setPageLoading(false)
 */
export function setPageLoading(on, opts){
  var wrap = byId('pageLoading');
  if (!wrap) return;

  // title
  var titleEl = byId('plText');
  if (typeof opts === 'string') {
    if (titleEl) titleEl.textContent = opts;
  } else if (opts && typeof opts.title === 'string') {
    if (titleEl) titleEl.textContent = opts.title;
  }

  // tips
  var tipsEl = byId('plTips');
  var tips = (opts && Array.isArray(opts.tips) && opts.tips.length) ? opts.tips : DEFAULT_TIPS.slice();

  // progress bar (indeterminate)
  var bar = $('.pl__bar span', wrap);

  if (on){
    wrap.classList.add('show');
    wrap.setAttribute('aria-busy', 'true');

    // tips rotasi
    if (_plTimer) clearInterval(_plTimer);
    _plIdx = 0;
    if (tipsEl) tipsEl.textContent = tips[_plIdx] || '';
    _plTimer = setInterval(function(){
      _plIdx = (_plIdx + 1) % tips.length;
      if (tipsEl) tipsEl.textContent = tips[_plIdx] || '';
    }, 1300);

    // bar animasi sederhana (lebar maju → reset → maju lagi)
    if (_plBarTimer) clearInterval(_plBarTimer);
    if (bar){
      var w = 8; var dir = 1;
      bar.style.width = w + '%';
      _plBarTimer = setInterval(function(){
        w += dir * 8;
        if (w >= 92) dir = -1;
        if (w <= 8)  dir = 1;
        bar.style.width = w + '%';
      }, 120);
    }
  } else {
    wrap.classList.remove('show');
    wrap.setAttribute('aria-busy','false');
    if (_plTimer){ clearInterval(_plTimer); _plTimer = null; }
    if (_plBarTimer){ clearInterval(_plBarTimer); _plBarTimer = null; }
  }
}
