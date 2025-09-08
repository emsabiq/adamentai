'use strict';
// shipping.js — ongkir + alamat + mode Antar/Pickup (pickup gratis, min 30 menit + spare)
// ES2019-safe (tanpa optional chaining / nullish)

import { byId, toast, money } from './utils.js';
import { State } from './state.js';

const WORKER_BASE = 'https://adamentai-ongkir-proxy.msabiq-stan.workers.dev';
const STORE       = { lat: 3.574856, lng: 98.702053 }; // Medan
const OSRM_BASE   = 'https://router.project-osrm.org';

// ===== Spare minimal pickup agar aman dari warning =====
const PICKUP_SPARE_SEC =
  (typeof window !== 'undefined' && window.CONFIG && Number(window.CONFIG.PICKUP_SPARE_SEC)) || 60; // 60 detik

// ===== TZ & jam server (untuk ikon) =====
const DEFAULT_TZ = 'Asia/Jakarta';
let STORE_TZ =
  (typeof window !== 'undefined' && window.CONFIG && window.CONFIG.STORE_TZ) || DEFAULT_TZ;

// nilai dari server /weather
let _serverClockHHMM = null;     // "HH:MM" lokal server (TZ toko)
let _serverClockTs   = 0;        // timestamp ketika diterima
let _serverRaining   = null;     // bool atau null

// ===== Night icon window (boleh di-override dari /config) =====
let NIGHT_ICON_FROM = (typeof window !== 'undefined' && window.CONFIG && window.CONFIG.NIGHT_ICON_FROM) ? String(window.CONFIG.NIGHT_ICON_FROM) : '18:00';
let NIGHT_ICON_TO   = (typeof window !== 'undefined' && window.CONFIG && window.CONFIG.NIGHT_ICON_TO)   ? String(window.CONFIG.NIGHT_ICON_TO)   : '06:00';
let _serverCfg = null;

// ====== Anti-jitter / smoothing ======
const NIGHT_HYSTERESIS_MS = 4 * 60 * 1000; // 4 menit tahan perubahan siang↔malam
let _nightDecision = null;    // boolean terakhir (true=malam)
let _nightDecisionTs = 0;     // kapan diputuskan

// Cache sinyal cuaca (hemat call)
let _lastWeatherTs = 0;
let _lastWeather = { rain: false, isNight: null };

// ================= Helpers =================
function H(h){ var d=document.createElement('div'); d.innerHTML=h.trim(); return d.firstElementChild; }
function setTextIf(id, txt){ var el = byId(id); if (el) el.textContent = txt; }
function toHHMM(d){ return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }

// Normalize "6", "06", "6:5", "06.05", "06:05 " -> minutes total
function _toMinNormalized(s){
  s = String(s || '').trim().replace('.',':').replace(/[^\d:]/g,'');
  if (!s) return 0;
  const p = s.split(':');
  let h = parseInt(p[0],10); if (!Number.isFinite(h)) h = 0;
  let m = p.length>1 ? parseInt(p[1],10) : 0; if (!Number.isFinite(m)) m = 0;
  h = ((h%24)+24)%24; m = ((m%60)+60)%60;
  return h*60+m;
}
function isNightRange(hhmm, from, to){
  const cur = _toMinNormalized(hhmm);
  const f   = _toMinNormalized(from);
  const t   = _toMinNormalized(to);
  return (f<=t) ? (cur>=f && cur<t) : (cur>=f || cur<t); // lintas tengah malam
}

function earliestPickupDate(){
  const d = new Date(Date.now() + (30*60 + PICKUP_SPARE_SEC) * 1000);
  d.setSeconds(0,0);
  return d;
}

// HH:MM pada timezone tertentu (fallback device bila Intl tak dukung TZ)
function hhmmInTZ(tz){
  try{
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz
    }).format(new Date());
  }catch(_){
    return toHHMM(new Date());
  }
}

/* Haversine km */
function distKm(lat1, lon1, lat2, lon2){
  const R=6371, toRad=function(x){return x*Math.PI/180;};
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
  return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

/* merge State.shipping (shallow) */
function mergeShipping(upd){
  var base = State.shipping || {};
  var out = Object.assign({}, base, upd || {});
  State.shipping = out;
  return out;
}

// ================= Styles =================
function injectStyles(){
  if (document.getElementById('shipStyles')) return;
  const s = document.createElement('style'); s.id='shipStyles';
  s.textContent = '\
    .ship-dest-box{font-size:12px;line-height:1.35;background:#0e1a33;color:#e5efff;border:1px solid var(--line);padding:8px 10px;border-radius:12px}\
    .ship-pill{display:inline-block;padding:6px 10px;border-radius:999px;background:#0b4c8a;color:#e6f3ff;font-size:12px;margin-top:8px}\
    .wg-chip{padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:#0e1a33;color:#e5efff;cursor:pointer;font-size:12px}\
    .wg-chip.is-on{background:#1e40af;color:#ffffff;border-color:#1e40af}\
    .wg-input{width:76px;font-size:12px;padding:6px 10px;border-radius:999px;background:#0e1a33;color:#e5efff;border:1px solid var(--line);outline:none}\
    .wg-input:focus{border-color:#1e40af;box-shadow:0 0 0 2px rgba(30,64,175,.28)}\
    #pickupTime, #pickupTime_m{ width:128px; min-width:128px; }\
    .ship-mode{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}\
    #cartDrawer .quantity button, #cartDrawer .qty button, #cartDrawer button.qty-minus, #cartDrawer button.qty-plus{\
      background:#0e1a33;border:1px solid var(--line);color:#e5efff;border-radius:9999px;font-size:12px; padding:6px 10px;line-height:1;min-width:34px;min-height:34px;display:inline-flex;align-items:center;justify-content:center;transition:transform .08s ease, background .15s ease, border-color .15s ease;}\
    #cartDrawer .quantity button:hover, #cartDrawer .qty button:hover, #cartDrawer button.qty-minus:hover, #cartDrawer button.qty-plus:hover{ background:#132244;border-color:#1e40af; }\
    #cartDrawer .quantity input[type=number], #cartDrawer .qty input[type=number], #cartDrawer input.qty-input{\
      background:#0e1a33;border:1px solid var(--line);color:#e5efff;border-radius:12px;font-size:12px;padding:6px 10px;width:48px;text-align:center;}\
    #cartDrawer .drawer__items .item-title{font-size:13px;line-height:1.3}\
    .ship-flags{display:inline-flex;gap:6px;margin-left:8px;vertical-align:middle}\
    .ship-flag{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;border:1px solid var(--line);background:#0e1a33;color:#10b981}\
    .ship-flag svg{width:12px;height:12px}\
    .ship-flag.ok{border-color:#065f46;background:rgba(16,185,129,.12);color:#10b981}\
    .ship-flag.bad{border-color:#7f1d1d;background:rgba(239,68,68,.12);color:#ef4444}\
  ';
  document.head.appendChild(s);
}

// ================= Leaflet (lazy) =================
function ensureLeaflet(){
  return new Promise(function(resolve,reject){
    if (window.L) return resolve();
    var css=document.createElement('link'); css.rel='stylesheet';
    css.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    css.integrity='sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; css.crossOrigin='';
    document.head.appendChild(css);
    var js=document.createElement('script'); js.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.integrity='sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='; js.crossOrigin='';
    js.onload=function(){ resolve(); }; js.onerror=function(){ reject(new Error('Leaflet load failed')); };
    document.head.appendChild(js);
  });
}

// ================= Inject UI helpers =================
function insertAfter(refNode, newNode){
  if (!refNode || !refNode.parentElement) return;
  if (refNode.nextSibling) refNode.parentElement.insertBefore(newNode, refNode.nextSibling);
  else refNode.parentElement.appendChild(newNode);
}

// ====== tiny svg ======
function svgRain(){ return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18c-2.8 0-5-2.2-5-5 0-2.4 1.7-4.5 4-4.9C6.5 4.9 8.6 3 11 3c3 0 5.5 2.5 5.5 5.5v.5H18c2.2 0 4 1.8 4 4s-1.8 4-4 4H7zM8 20l1-2m3 2l1-2m3 2l1-2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'; }
function svgCloud(){ return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18c-2.8 0-5-2.2-5-5 0-2.4 1.7-4.5 4-4.9C6.5 4.9 8.6 3 11 3c3 0 5.5 2.5 5.5 5.5v.5H18c2.2 0 4 1.8 4 4S20.2 18 18 18H7z" fill="currentColor"/></svg>'; }
function svgMoon(){ return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/></svg>'; }
function svgSun(){ return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v2m0 16v2M4 12H2m20 0h-2M5.6 5.6 4.2 4.2m15.6 15.6-1.4-1.4M18.4 5.6l1.4-1.4M5.6 18.4l-1.4 1.4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'; }

// ================= Inject UI (desktop) =================
function ensureDesktopFlagsContainer(){
  if (!byId('shipFlags')) {
    var strong = byId('cartShipping');
    if (strong && strong.parentElement){
      var span = H('<span id="shipFlags" class="ship-flags" aria-label="Status cuaca & waktu"></span>');
      strong.parentElement.appendChild(span);
    }
  }
}
function injectCartUI(){
  var disc = byId('cartDiscount');
  var anchorRow = disc && disc.closest ? disc.closest('.row') : null;
  var fallbackContainer = document.querySelector('aside.cart .summary') || (anchorRow && anchorRow.parentElement) || document.body;

  // Baris Ongkir + flags
  if (!byId('cartShipping') && anchorRow){
    insertAfter(anchorRow, H('<div class="row"><span>Ongkir</span><div style="display:flex;align-items:center;gap:6px"><strong id="cartShipping" data-cart-shipping>Rp0</strong><span id="shipFlags" class="ship-flags" aria-label="Status cuaca & waktu"></span></div></div>'));
  }

  // Kontrol mode + alamat + berat + pickup
  if (!byId('shipDestLabel')){
    var ctl = H('\
      <div style="margin-top:8px">\
        <div class="ship-mode">\
          <button id="modeDelivery" class="wg-chip is-on" type="button">Antar</button>\
          <button id="modePickup"   class="wg-chip"       type="button">Ambil sendiri</button>\
        </div>\
        <div class="ship-dest-box"><span id="shipDestLabel">Pilih lokasi pengantaran</span></div>\
        <div id="deliveryBox" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">\
          <button id="btnShipMap"  class="btn btn--ghost" type="button">Pilih di Peta</button>\
          <button id="btnShipAuto" class="btn btn--ghost" type="button">Lokasi saya</button>\
          <div style="display:flex;align-items:center;gap:6px;font-size:12px">\
            <span style="opacity:.8">Berat</span>\
            <div id="wgChips" style="display:flex;gap:6px">\
              <button class="wg-chip" data-wg="1" type="button">1 kg</button>\
              <button class="wg-chip" data-wg="2" type="button">2 kg</button>\
              <button class="wg-chip" data-wg="3" type="button">3 kg</button>\
            </div>\
            <input id="shipWeight" class="wg-input" type="number" step="0.1" min="0.1" value="1" />\
          </div>\
        </div>\
        <div id="pickupBox" style="display:none;margin-top:8px">\
          <label style="font-size:12px;opacity:.85;display:block;margin-bottom:4px">Waktu ambil (≥ 30 menit dari sekarang)</label>\
          <input id="pickupTime" class="wg-input" type="time" />\
        </div>\
        <div id="shipPill" class="ship-pill"></div>\
      </div>');
    if (anchorRow) insertAfter(anchorRow, ctl); else fallbackContainer.appendChild(ctl);
  }

  ensureDesktopFlagsContainer();
}

// ================= Inject UI (mobile) =================
function ensureMobileFlagsContainer(){
  if (!byId('shipFlags_m')) {
    var sum = document.querySelector('#cartDrawer .drawer-summary');
    if (sum){
      if (!sum.querySelector('[data-cart-shipping]')){
        sum.appendChild(H('<div><span>Ongkir</span> <span data-cart-shipping>Rp0</span> <span id="shipFlags_m" class="ship-flags" aria-label="Status cuaca & waktu"></span></div>'));
      } else {
        var ship = sum.querySelector('[data-cart-shipping]');
        if (ship && ship.parentElement && !byId('shipFlags_m')){
          ship.parentElement.appendChild(H('<span id="shipFlags_m" class="ship-flags" aria-label="Status cuaca & waktu"></span>'));
        }
      }
    }
  }
}
function injectMobileUI(){
  ensureMobileFlagsContainer();

  var cont = document.querySelector('#cartDrawer .drawer__customer');
  if (cont && !byId('shipMini_m')){
    cont.prepend(H('\
      <div id="shipMini_m" style="margin:8px 0">\
        <div class="ship-mode">\
          <button id="modeDelivery_m" class="wg-chip is-on" type="button">Antar</button>\
          <button id="modePickup_m"   class="wg-chip"       type="button">Ambil sendiri</button>\
        </div>\
        <div class="ship-dest-box"><span id="shipDestLabel_m">Pilih lokasi pengantaran</span></div>\
        <div id="deliveryBox_m" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">\
          <button id="btnShipMap_m"  class="btn btn--ghost" type="button">Pilih di Peta</button>\
          <button id="btnShipAuto_m" class="btn btn--ghost" type="button">Lokasi saya</button>\
          <div style="display:flex;align-items:center;gap:6px;font-size:12px">\
            <span style="opacity:.8">Berat</span>\
            <div id="wgChips_m" style="display:flex;gap:6px">\
              <button class="wg-chip" data-wg="1" type="button">1 kg</button>\
              <button class="wg-chip" data-wg="2" type="button">2 kg</button>\
              <button class="wg-chip" data-wg="3" type="button">3 kg</button>\
            </div>\
            <input id="shipWeight_m" class="wg-input" type="number" step="0.1" min="0.1" value="1" />\
          </div>\
        </div>\
        <div id="pickupBox_m" style="display:none;margin-top:8px">\
          <label style="font-size:12px;opacity:.85;display:block;margin-bottom:4px">Waktu ambil (≥ 30 menit dari sekarang)</label>\
          <input id="pickupTime_m" class="wg-input" type="time" />\
        </div>\
        <div id="shipPill_m" class="ship-pill"></div>\
      </div>'));
  }
}

// ================= HTTP helpers =================
async function fetchJson(url, opts, tries){
  opts = opts || {}; tries = (typeof tries === 'number') ? tries : 1;
  for (let i=0;i<tries;i++){
    try{
      const ctl=new AbortController();
      const to=setTimeout(function(){ try{ ctl.abort(); }catch(_){ } },9000);
      const fopts = Object.assign({}, opts, { signal: ctl.signal });
      const r=await fetch(url, fopts); clearTimeout(to);
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){
      if(i===tries-1) throw e;
      await new Promise(function(r){ return setTimeout(r,300); });
    }
  }
}

// ================= Config + Server Clock =================
async function refreshServerClock(){
  try{
    const w = await fetchJson(
      WORKER_BASE + '/weather?lat='+encodeURIComponent(STORE.lat)+'&lon='+encodeURIComponent(STORE.lng),
      {}, 1
    );
    if (w){
      if (w.tz) STORE_TZ = String(w.tz || DEFAULT_TZ);
      if (typeof w.raining === 'boolean') _serverRaining = w.raining;
      if (w.now_local){ _serverClockHHMM = String(w.now_local); _serverClockTs = Date.now(); }
    }
  }catch(_){ /* ignore */ }
}
async function loadServerConfig(){
  try{
    const cfgResp = await fetchJson(WORKER_BASE + '/config', {}, 1);
    if (cfgResp && cfgResp.cfg){
      _serverCfg = cfgResp.cfg;
      if (typeof _serverCfg.nightFrom !== 'undefined') NIGHT_ICON_FROM = String(_serverCfg.nightFrom);
      if (typeof _serverCfg.nightTo   !== 'undefined') NIGHT_ICON_TO   = String(_serverCfg.nightTo);
    }
  }catch(_){ /* ignore */ }
  await refreshServerClock();
}

// ================= Geocoding =================
async function geocodeNearby(q){
  const u=new URL(WORKER_BASE+'/geocode');
  u.searchParams.set('q',q); u.searchParams.set('limit','8'); u.searchParams.set('lang','id');
  u.searchParams.set('lat',String(STORE.lat)); u.searchParams.set('lon',String(STORE.lng));
  u.searchParams.set('radius_km','10');
  try{ return await fetchJson(u.toString(),{},2); }catch(_){ return []; }
}
async function reverseGeocode(lat,lng){
  try{ return await fetchJson(WORKER_BASE + '/reverse?lat='+lat+'&lon='+lng+'&lang=id', {}, 2); }
  catch(_){ return null; }
}

// ================= Modal Peta =================
function injectModal(){
  if (byId('shipModal')) return;
  document.body.appendChild(H('\
    <div id="shipModal" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:9999">\
      <div style="background:#0f172a;color:#e5efff;border:1px solid #1f2a44;border-radius:14px;width:min(92vw,960px);padding:10px">\
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">\
          <strong>Pilih lokasi tujuan</strong>\
          <button id="shipClose" class="btn btn--ghost" type="button">Tutup</button>\
        </div>\
        <div style="position:relative">\
          <div id="shipMap" style="height:460px;border-radius:12px;overflow:hidden"></div>\
          <div style="position:absolute;left:12px;right:12px;top:12px;display:flex;gap:8px;z-index:1000;pointer-events:auto">\
            <input id="shipMapSearch" class="input" placeholder="Cari alamat / tempat (≤ 10 km dari toko)..." autocomplete="off" style="flex:1">\
            <button id="shipMapMe" class="btn btn--ghost" type="button">Lokasi saya</button>\
          </div>\
          <div id="shipMapSug" style="position:absolute;left:12px;right:12px;top:56px;max-height:190px;overflow:auto;z-index:1001;pointer-events:auto"></div>\
        </div>\
        <div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:8px">\
          <button id="shipUseHere" class="btn" type="button">Pakai Titik Ini</button>\
        </div>\
      </div>\
    </div>'));
}
function openModal(){ var el=byId('shipModal'); if(el) el.style.display='flex'; }
function closeModal(){ var s=byId('shipMapSug'); if(s) s.innerHTML=''; var el=byId('shipModal'); if(el) el.style.display='none'; }

let routeLayer=null, marker=null, mapInst=null, _mapBound=false;

function ensureMapMarker(lat,lng){
  if(!marker){
    marker = L.marker([lat,lng],{draggable:true}).addTo(mapInst);
    marker.on('dragend', async function(e){
      var p=e.target.getLatLng();
      await handlePicked(p.lat,p.lng);
      setDestination(p.lat,p.lng);
    });
  }else{
    marker.setLatLng([lat,lng]);
  }
}

async function initMapAndPick(){
  await ensureLeaflet(); injectStyles(); injectModal(); openModal(); bindMapSearch();
  if(!mapInst){
    mapInst = L.map('shipMap', { zoomControl: false }).setView([STORE.lat, STORE.lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OSM' }).addTo(mapInst);
    L.control.zoom({ position: 'bottomright' }).addTo(mapInst);
    L.marker([STORE.lat, STORE.lng]).addTo(mapInst).bindPopup('Origin (Toko)');
  }else{
    setTimeout(function(){ try{ mapInst.invalidateSize(); }catch(_){ } },60);
  }
  if(!_mapBound){
    _mapBound = true;
    mapInst.on('click', function(e){
      ensureMapMarker(e.latlng.lat, e.latlng.lng);
      handlePicked(e.latlng.lat, e.latlng.lng);
      setDestination(e.latlng.lat, e.latlng.lng);
    });
    var useBtn = byId('shipUseHere'); if (useBtn) useBtn.addEventListener('click', function(){
      if(!marker){ toast('Klik peta untuk pilih titik'); return; }
      var p = marker.getLatLng();
      setDestination(p.lat, p.lng);
      closeModal();
    });
    var closeBtn = byId('shipClose'); if (closeBtn) closeBtn.addEventListener('click', closeModal);
    var meBtn = byId('shipMapMe'); if (meBtn) meBtn.addEventListener('click', async function(){
      try{
        var p = await geolocateMe();
        mapInst.setView([p.lat, p.lng], 16);
        ensureMapMarker(p.lat, p.lng);
        await handlePicked(p.lat, p.lng);
        setDestination(p.lat, p.lng);
      }catch(_){ toast('Gagal akses lokasi (butuh HTTPS & izin).', 2200); }
    });
  }
}

async function osrmRoute(origin,dest){
  const u = OSRM_BASE + '/route/v1/driving/' + origin.lng + ',' + origin.lat + ';' + dest.lng + ',' + dest.lat + '?overview=full&geometries=geojson';
  const r = await fetch(u);
  if(!r.ok) throw new Error('OSRM HTTP '+r.status);
  const d = await r.json();
  const rt = d && d.routes && d.routes.length ? d.routes[0] : null;
  if(!rt) throw new Error('OSRM no route');
  return { distance_km: rt.distance/1000, eta_min: Math.round(rt.duration/60), geojson: rt.geometry };
}
async function handlePicked(lat,lng){
  if(routeLayer){ try{ mapInst.removeLayer(routeLayer); }catch(_){ } routeLayer=null; }
  try{
    const rt=await osrmRoute(STORE,{lat:lat,lng:lng});
    const gj={type:'Feature',properties:{},geometry:rt.geojson};
    routeLayer=L.geoJSON(gj,{style:{color:'#38bdf8',weight:4,opacity:.95}}).addTo(mapInst);
    try{ mapInst.fitBounds(routeLayer.getBounds(),{padding:[20,20]}); }catch(_){ }
    mergeShipping({ _picked:{lat:lat,lng:lng}, route:rt, _last_delivery_route:rt });
    renderSummary();
  }catch(_){}
}

// ================= Search in modal (≤ 10 km) =================
function bindMapSearch(){
  var inp=byId('shipMapSearch'), sug=byId('shipMapSug');
  if(!inp || (inp && inp.dataset && inp.dataset.bound)) return;
  if (inp && inp.dataset) inp.dataset.bound='1';
  var t=null;
  inp.addEventListener('input', function(){
    var q=inp.value.trim(); clearTimeout(t);
    if(q.length<3){ if(sug) sug.innerHTML=''; return; }
    t=setTimeout(async function(){
      if (sug) sug.innerHTML='<div class="note" style="padding:6px 8px;border-radius:10px;background:#0e1a33;border:1px solid var(--line)">Mencari…</div>';
      var raw=[]; try{ raw=await geocodeNearby(q); }catch(_){ raw=[]; }
      var list = raw.filter(function(r){ return distKm(STORE.lat,STORE.lng,r.lat,r.lng) <= 10; });
      if(!list.length){ if (sug) sug.innerHTML='<div class="note" style="padding:6px 8px;border-radius:10px;background:#0e1a33;border:1px solid var(--line)">Tidak ada hasil dalam radius 10 km</div>'; return; }
      if (sug){
        sug.innerHTML = list.map(function(r,i){ return '<div data-i="'+i+'" style="padding:6px 8px;border:1px solid var(--line);border-radius:10px;margin:4px 0;cursor:pointer;background:#0e1a33;color:#e5efff">'+r.label+'</div>'; }).join('');
        var nodes = sug.querySelectorAll('[data-i]');
        for (var n=0;n<nodes.length;n++){
          (function(el){
            el.addEventListener('click', async function(){
              var idx = Number(el.getAttribute('data-i')||'-1');
              var p = list[idx]; if(!p) return;
              try{ mapInst.setView([p.lat,p.lng],16);}catch(_){}
              ensureMapMarker(p.lat,p.lng);
              await handlePicked(p.lat,p.lng);
              setDestination(p.lat,p.lng,p.label);
              sug.innerHTML='';
            });
          })(nodes[n]);
        }
      }
    },280);
  });
}

// ================= Mode (delivery / pickup) =================
function setMode(mode){
  var isPickup = mode === 'pickup';

  var md  = byId('modeDelivery'); var mp  = byId('modePickup');
  var mdm = byId('modeDelivery_m'); var mpm = byId('modePickup_m');
  if (md)  md.classList.toggle('is-on', !isPickup);
  if (mp)  mp.classList.toggle('is-on', isPickup);
  if (mdm) mdm.classList.toggle('is-on', !isPickup);
  if (mpm) mpm.classList.toggle('is-on', isPickup);

  var dBox  = byId('deliveryBox');  var pBox  = byId('pickupBox');
  var dBoxm = byId('deliveryBox_m');var pBoxm = byId('pickupBox_m');
  if (dBox)  dBox.style.display  = isPickup ? 'none' : 'flex';
  if (dBoxm) dBoxm.style.display = isPickup ? 'none' : 'flex';
  if (pBox)  pBox.style.display  = isPickup ? 'block' : 'none';
  if (pBoxm) pBoxm.style.display = isPickup ? 'block' : 'none';

  if (isPickup){
    var prev = State.shipping || {};
    var minDate = earliestPickupDate();
    var hhmm = toHHMM(minDate);
    var t1 = byId('pickupTime'); var t2 = byId('pickupTime_m');
    if (t1){ t1.min = hhmm; if (!t1.value || t1.value < hhmm) t1.value = hhmm; }
    if (t2){ t2.min = hhmm; if (!t2.value || t2.value < hhmm) t2.value = hhmm; }

    mergeShipping({
      _last_delivery_dest   : prev.dest || prev._last_delivery_dest || null,
      _last_delivery_address: (prev.address && prev.address !== 'Ambil di Toko') ? prev.address : (prev._last_delivery_address || null),
      _last_delivery_route  : prev.route || prev._last_delivery_route || null,
      mode: 'pickup', fee: 0, dest: null, address: 'Ambil di Toko',
      pickup_time: (t1 && t1.value) ? t1.value : ((t2 && t2.value) ? t2.value : hhmm),
      breakdown: null
    });

    setTextIf('shipDestLabel','Ambil di Toko');
    setTextIf('shipDestLabel_m','Ambil di Toko');
  } else {
    var prev2 = State.shipping || {};
    var lastDest  = prev2._last_delivery_dest   || null;
    var lastAddr  = prev2._last_delivery_address|| null;
    var lastRoute = prev2._last_delivery_route  || null;

    mergeShipping({ mode:'delivery', dest:lastDest, address:lastAddr || null, route:lastRoute || null, pickup_time:null, fee: lastDest ? prev2.fee : 0 });

    setTextIf('shipDestLabel', lastAddr || 'Pilih lokasi pengantaran');
    setTextIf('shipDestLabel_m', lastAddr || 'Pilih lokasi pengantaran');

    if (!lastDest){ setTextIf('shipPill',''); setTextIf('shipPill_m',''); }
    else { quoteIfReady(0); }
  }

  renderSummary();
  try{ window.dispatchEvent(new Event('shipping:updated')); }catch(_){}
}

// ================= Tujuan & auto-quote =================
function setDestination(lat,lng,labelText){
  var prevPicked = (State.shipping && State.shipping._picked) ? State.shipping._picked : null;
  var same = prevPicked && Math.abs(prevPicked.lat-lat)<1e-6 && Math.abs(prevPicked.lng-lng)<1e-6;
  var route = same ? (State.shipping && State.shipping.route) : null;

  mergeShipping({ dest:{lat:Number(lat),lng:Number(lng)}, route:route, mode:'delivery', _last_delivery_dest:{lat:Number(lat),lng:Number(lng)} });

  function apply(txt){
    mergeShipping({ address:txt, _last_delivery_address:txt });
    setTextIf('shipDestLabel',txt); setTextIf('shipDestLabel_m',txt);
    renderSummary(); quoteIfReady(0);
  }
  if(labelText) apply(labelText);
  else{
    reverseGeocode(lat,lng).then(function(a){
      var label = a && a.label ? a.label : (lat.toFixed(6)+', '+lng.toFixed(6));
      apply(label);
    }).catch(function(){ apply(lat.toFixed(6)+', '+lng.toFixed(6)); });
  }

  setMode('delivery');
  try{ window.dispatchEvent(new Event('shipping:updated')); }catch(_){}
}

// ================= Berat controls =================
// ================= Berat controls (fix: bisa ketik manual, tidak otomatis balik ke 1) =================
function bindWeightControls(){
  var chipsD = document.querySelectorAll('#wgChips .wg-chip');
  var chipsM = document.querySelectorAll('#wgChips_m .wg-chip');

  function mark(nodes, val){
    var num = Number(val);
    for (var i=0; i<nodes.length; i++){
      var n = nodes[i];
      var on = (Number(n.getAttribute('data-wg')) === num);
      if (on) n.classList.add('is-on'); else n.classList.remove('is-on');
    }
  }

  // Saat KOMIT (klik chip / blur / change / Enter) -> normalisasi + tulis balik + quoteIfReady
  function commitWeight(val, src){
    var raw = String(val == null ? '' : val).trim().replace(',', '.'); // izinkan koma
    var num = Number(raw);
    if (!isFinite(num) || num <= 0) num = 1;
    num = Math.max(0.1, num);
    // pembulatan ringan 2 desimal biar rapi
    num = Math.round(num * 100) / 100;

    var iD = byId('shipWeight');
    var iM = byId('shipWeight_m');
    if (iD) iD.value = String(num);
    if (iM) iM.value = String(num);

    mark(chipsD, num); mark(chipsM, num);
    if (src !== 'init') quoteIfReady();
  }

  // Saat sedang KETIK -> hanya update highlight kalau valid, jangan tulis balik
  function liveWeight(val){
    var raw = String(val == null ? '' : val).trim().replace(',', '.');
    var num = Number(raw);
    if (isFinite(num) && num > 0){
      mark(chipsD, num); mark(chipsM, num);
    }
    // tidak menulis ke input -> caret & teks pengguna aman
  }

  // Bind chips (commit langsung)
  for (var c=0; c<chipsD.length; c++){
    (function(b){ b.addEventListener('click', function(){ commitWeight(b.getAttribute('data-wg'), 'chip'); }); })(chipsD[c]);
  }
  for (var cm=0; cm<chipsM.length; cm++){
    (function(b){ b.addEventListener('click', function(){ commitWeight(b.getAttribute('data-wg'), 'chip'); }); })(chipsM[cm]);
  }

  // Bind input desktop & mobile
  var wD = byId('shipWeight');
  var wM = byId('shipWeight_m');

  function bindInput(inp){
    if (!inp) return;
    inp.addEventListener('input',  function(){ liveWeight(inp.value); });         // ketik bebas
    inp.addEventListener('blur',   function(){ commitWeight(inp.value, 'commit'); }); // saat selesai
    inp.addEventListener('change', function(){ commitWeight(inp.value, 'commit'); });
    inp.addEventListener('keydown', function(e){
      var k = e.key || e.keyCode;
      if (k === 'Enter' || k === 13) commitWeight(inp.value, 'commit');
    });
  }
  bindInput(wD);
  bindInput(wM);

  // Nilai awal
  commitWeight(1, 'init');
}


// ================= Pickup time controls =================
var _pickupMinTimer=null;
function refreshPickupMin(){
  const minHHMM = toHHMM(earliestPickupDate());
  const t1 = byId('pickupTime'); const t2 = byId('pickupTime_m');

  if (t1){
    t1.min = minHHMM;
    if (!t1.value || t1.value < minHHMM) t1.value = minHHMM;
  }
  if (t2){
    t2.min = minHHMM;
    if (!t2.value || t2.value < minHHMM) t2.value = minHHMM;
  }

  const s = State.shipping || {};
  if (s.mode === 'pickup'){
    const val = (t1 && t1.value) || (t2 && t2.value) || minHHMM;
    mergeShipping({ pickup_time: val, fee:0, dest:null, address:'Ambil di Toko', breakdown:null });
    try{ window.dispatchEvent(new Event('shipping:updated')); }catch(_){}
  }
}
function schedulePickupMinRefresh(){
  try{ if (_pickupMinTimer) clearInterval(_pickupMinTimer); }catch(_){}
  _pickupMinTimer = setInterval(refreshPickupMin, 30000); // tiap 30 detik
}

function bindPickupTime(){
  function apply(val){
    const minHHMM = toHHMM(earliestPickupDate());
    const newVal = (val && val >= minHHMM) ? val : minHHMM;
    const t1 = byId('pickupTime'); const t2 = byId('pickupTime_m');
    if (t1) t1.value = newVal;
    if (t2) t2.value = newVal;

    mergeShipping({ pickup_time: newVal, mode:'pickup', fee:0, dest:null, address:'Ambil di Toko', breakdown:null });
    renderSummary();
    try{ window.dispatchEvent(new Event('shipping:updated')); }catch(_){}
    return true;
  }
  const t1 = byId('pickupTime'); const t2 = byId('pickupTime_m');
  refreshPickupMin();
  if (t1){ t1.addEventListener('change', function(){ apply(t1.value); }); }
  if (t2){ t2.addEventListener('change', function(){ apply(t2.value); }); }
  schedulePickupMinRefresh();
}

// ================= Cuaca (rain + night) =================
// API Open-Meteo: current: rain, precipitation, weather_code, is_day
async function detectLocalWeather(lat, lng, timeoutMs){
  const ctl = new AbortController();
  const t = setTimeout(function(){ try{ ctl.abort(); }catch(_){ } }, Math.max(800, Number(timeoutMs)||2000));
  try{
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat)
              + '&longitude=' + encodeURIComponent(lng)
              + '&current=rain,precipitation,weather_code,is_day&timezone=auto';
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return { rain:false, isNight:null };
    const j = await r.json();
    const cur = j && j.current ? j.current : {};
    const rainMm = Number(cur.rain || cur.precipitation || 0);
    const code = Number(cur.weather_code || 0);
    const isCodeRain = (code>=51 && code<=67) || (code>=80 && code<=82);
    const isDay = (typeof cur.is_day === 'number') ? (cur.is_day===1) : null;
    return { rain: (rainMm>0) || isCodeRain, isNight: (isDay===null ? null : !isDay) };
  }catch(_){
    return { rain:false, isNight:null };
  }
}

// kompatibilitas lama (kalau dipakai di tempat lain)
async function detectRainAt(lat,lng,timeoutMs){
  const w = await detectLocalWeather(lat,lng,timeoutMs);
  return !!w.rain;
}

// ================= Quote =================
var _quoteT=null;
var _quoteRunning=false;

var _lastRainCheckTs = 0;

function quoteIfReady(delay){
  delay = (typeof delay === 'number') ? delay : 400;
  try{ if (_quoteT) clearTimeout(_quoteT); }catch(_){}
  _quoteT = setTimeout(function(){ doQuote().catch(function(){}); }, delay);
}

function setShippingDisplayText(txt){
  var nodes = document.querySelectorAll('[data-cart-shipping]');
  for (var i=0;i<nodes.length;i++){ nodes[i].textContent = txt; }
}

async function post(path,payload){
  const pillD=byId('shipPill'), pillM=byId('shipPill_m');
  if(pillD) pillD.textContent='Menghitung…';
  if(pillM) pillM.textContent='Menghitung…';
  setShippingDisplayText('…');
  const r=await fetch(WORKER_BASE+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  let data={}; try{ data=await r.json(); }catch(_){ data={}; }
  if(!r.ok || (data && data.error)) throw new Error((data && data.error) || r.statusText || 'HTTP error');
  return data;
}
async function geolocateMe(){
  return new Promise(function(res,rej){
    if(!navigator.geolocation) return rej(new Error('Geolocation tidak didukung'));
    navigator.geolocation.getCurrentPosition(function(p){ res({lat:p.coords.latitude,lng:p.coords.longitude}); }, rej, {enableHighAccuracy:true,timeout:8000});
  });
}

async function doQuote(){
  const s = State.shipping || {};
  if (s.mode === 'pickup'){
    mergeShipping({ fee:0, breakdown:null });
    renderSummary();
    try{ window.dispatchEvent(new Event('shipping:updated')); }catch(_){}
    return;
  }
  const d = s.dest;
  if(!d) return;

  _quoteRunning = true;
  try{ window.dispatchEvent(new Event('shipping:quote:start')); }catch(_){}

  const hasDist = s && s.route && typeof s.route.distance_km === 'number';
  if(!hasDist){
    try{
      const rt = await osrmRoute(STORE,d);
      mergeShipping({ route:rt, _last_delivery_route:rt });
      renderSummary();
    }catch(_){}
  }

  // deteksi cuaca lokal (rain + night) tiap 60 dtk
  const now = Date.now();
  if (now - _lastWeatherTs > 60000) {
    try { _lastWeather = await detectLocalWeather(d.lat, d.lng, 2000); } catch(_){ _lastWeather = {rain:false, isNight:null}; }
    _lastWeatherTs = now;
  }

  const wEl = byId('shipWeight');
  const wElM = byId('shipWeight_m');
  const kg = Number((wEl && wEl.value) ? wEl.value : ((wElM && wElM.value) ? wElM.value : 1));
  const dist = (State.shipping && State.shipping.route && typeof State.shipping.route.distance_km === 'number')
    ? Number(State.shipping.route.distance_km) : 0;

  const payload = {
    origin: STORE,
    dest: { lat:d.lat, lng:d.lng },
    weight_kg: kg,
    order_time_local: (_serverClockHHMM && (Date.now()-_serverClockTs)<120000) ? _serverClockHHMM : hhmmInTZ(STORE_TZ),
    rain: 'auto', // pricing biar Worker yang putuskan
    distance_km_override: dist>0 ? Number(dist.toFixed(2)) : undefined,
    address_text: (State.shipping && State.shipping.address) ? State.shipping.address : ''
  };

  let q=null;
  try{ q = await post('/quote',payload); }catch(_){ q=null; }

  if(q && q.deliverable === false){
    mergeShipping({ fee:0, quote:q, eta_min:null, breakdown:q.breakdown || { rain_fee: 0, night_fee: 0 } });
    const msg = q.reason || 'Di luar jangkauan';
    setTextIf('shipPill',msg); setTextIf('shipPill_m',msg); toast(msg,2200);
  }else if(q){
    const etaFromQ = (typeof q.eta_min !== 'undefined' && q.eta_min !== null) ? q.eta_min : null;
    const etaFallback = (State.shipping && State.shipping.route && typeof State.shipping.route.eta_min === 'number') ? State.shipping.route.eta_min : null;
    const etaFinal = (etaFromQ !== null) ? etaFromQ : etaFallback;

    const distFromQ = (typeof q.distance_km !== 'undefined' && q.distance_km !== null) ? q.distance_km : null;
    const distFinal = (distFromQ !== null) ? distFromQ : ((typeof dist === 'number' && isFinite(dist)) ? dist : null);

    mergeShipping({
      fee: (typeof q.price === 'number') ? q.price : 0,
      quote: q, eta_min: etaFinal, distance_km: distFinal,
      breakdown: q.breakdown || { rain_fee: 0, night_fee: 0 },
      _rain_detected: (typeof _serverRaining === 'boolean') ? _serverRaining : !!_lastWeather.rain
    });
    renderSummary();
  }

  _quoteRunning = false;
  try{ window.dispatchEvent(new Event('shipping:quote:end')); }catch(_){}
  try{ window.dispatchEvent(new Event('shipping:updated')); }catch(_){}
}

// ================= Flags render =================
function ensureFlagsUI(){
  ensureDesktopFlagsContainer();
  ensureMobileFlagsContainer();

  function ensure(containerId){
    const host = byId(containerId);
    if (!host) return;
    if (!host.querySelector('.ship-flag.rain')){
      const el = H('<span class="ship-flag rain ok" id="'+(containerId==='shipFlags'?'flagRain':'flagRain_m')+'" title="Tidak hujan">'+svgCloud()+'</span>');
      host.appendChild(el);
    }
    if (!host.querySelector('.ship-flag.night')){
      const el2 = H('<span class="ship-flag night ok" id="'+(containerId==='shipFlags'?'flagNight':'flagNight_m')+'" title="Siang">'+svgSun()+'</span>');
      host.appendChild(el2);
    }
  }
  ensure('shipFlags');
  ensure('shipFlags_m');
}

function updateFlag(which, active){
  const el = byId(which);
  if (!el) return;
  const isRain = which.indexOf('Rain')>=0;
  if (isRain){
    el.classList.toggle('bad', !!active);
    el.classList.toggle('ok', !active);
    el.innerHTML = active ? svgRain() : svgCloud();
    el.title = active ? 'Hujan' : 'Tidak hujan';
  } else {
    el.classList.toggle('bad', !!active);
    el.classList.toggle('ok', !active);
    el.innerHTML = active ? svgMoon() : svgSun();
    el.title = active ? 'Malam' : 'Siang';
  }
}

function _pickNowHHMM(){
  // pakai jam server kalau masih fresh (< 2 menit), else WIB via Intl (TZ toko)
  if (_serverClockHHMM && (Date.now()-_serverClockTs) < 120000) return _serverClockHHMM;
  return hhmmInTZ(STORE_TZ || DEFAULT_TZ);
}

// keputusan night dengan hysteresis + prioritas sinyal
function decideIsNight(breakdown){
  const now = Date.now();

  // 1) Jika pricing kasih night_fee>0 → pasti malam (prioritas tertinggi)
  if (breakdown && Number(breakdown.night_fee) > 0) {
    _nightDecision = true; _nightDecisionTs = now;
    return true;
  }

  // 2) Jika cuaca kasih isNight (dari is_day) dan fresh → gunakan
  var weatherNight = _lastWeather && _lastWeather.isNight;
  var weatherFresh = (now - _lastWeatherTs) <= 70000; // 70 detik
  var candidate = null;
  if (weatherFresh && typeof weatherNight === 'boolean') {
    candidate = weatherNight;
  } else {
    // 3) Fallback ke window jam malam dari config / default
    const nowHHMM = _pickNowHHMM();
    candidate = isNightRange(nowHHMM, NIGHT_ICON_FROM, NIGHT_ICON_TO);
  }

  // 4) Hysteresis: jika beda dengan keputusan terakhir dan belum lewat ambang, tahan
  if (_nightDecision !== null && candidate !== _nightDecision) {
    if ((now - _nightDecisionTs) < NIGHT_HYSTERESIS_MS) {
      // tahan
      return _nightDecision;
    }
  }
  // terima keputusan baru
  _nightDecision = candidate; _nightDecisionTs = now;
  return candidate;
}

function renderFlagsFromBreakdown(){
  ensureFlagsUI();
  const bd = (State.shipping && State.shipping.breakdown) || null;

  // Rain: server (/weather) > deteksi lokal > surcharge
  const rainSrv = (typeof _serverRaining === 'boolean') ? _serverRaining : null;
  const isRainSrv  = rainSrv === true;
  const isRainLoc  = !!(_lastWeather && _lastWeather.rain);
  const isRainFee  = !!(bd && Number(bd.rain_fee)  > 0);
  const isRain     = isRainSrv || isRainLoc || isRainFee;

  // Night: keputusan terpusat (lihat hysteresis)
  const isNight = decideIsNight(bd);

  updateFlag('flagRain',  isRain);
  updateFlag('flagNight', isNight);
  updateFlag('flagRain_m',  isRain);
  updateFlag('flagNight_m', isNight);
}

// ================= Summary =================
function renderSummary(){
  const s=State.shipping||{};
  if(s.mode==='pickup'){
    setTextIf('shipDestLabel','Ambil di Toko');
    setTextIf('shipDestLabel_m','Ambil di Toko');
    const when = s.pickup_time ? ('• ' + s.pickup_time) : '';
    const pill=('Ambil sendiri • Gratis ' + when).trim();
    setTextIf('shipPill',pill); setTextIf('shipPill_m',pill);
    setShippingDisplayText('Rp0');
    renderFlagsFromBreakdown();
    return;
  }
  const addr = (s.address && s.address !== 'Ambil di Toko') ? s.address : '';
  setTextIf('shipDestLabel', addr || 'Pilih lokasi pengantaran');
  setTextIf('shipDestLabel_m', addr || 'Pilih lokasi pengantaran');

  if (!addr || !s.dest){
    setTextIf('shipPill',''); setTextIf('shipPill_m','');
    setShippingDisplayText('Rp0');
    renderFlagsFromBreakdown();
    return;
  }

  const hasRouteDist = (s.route && typeof s.route.distance_km === 'number');
  const km = hasRouteDist ? ('≈ ' + s.route.distance_km.toFixed(2) + ' km') : '';
  const feeText = (typeof s.fee==='number') ? money(s.fee) : 'Rp0';
  const feePill = (typeof s.fee==='number') ? ('• ' + money(s.fee)) : '';
  const pillTxt=[km,feePill].filter(Boolean).join(' ');
  setTextIf('shipPill',pillTxt); setTextIf('shipPill_m',pillTxt);
  setShippingDisplayText(feeText);

  renderFlagsFromBreakdown();
}

// ================= Checkout Interlock =================
var _interlockBound=false;

function isReadyForCheckout(){
  const s = State.shipping || {};
  if (s.mode === 'pickup') return true;
  if (!s.dest) return false;
  if (_quoteRunning) return false;
  if (s.quote && s.quote.deliverable === false) return false;
  const feeNum = Number(s.fee);
  if (!isFinite(feeNum) || feeNum < 0) return false;
  return true;
}

function setCheckoutDisabled(flag){
  const sels = ['#btnCheckout','#btnCheckoutBar','#btnCheckoutMobile','[data-checkout]'];
  const nodes = [];
  for (let i=0;i<sels.length;i++){
    const list = document.querySelectorAll(sels[i]);
    for (let j=0;j<list.length;j++) nodes.push(list[j]);
  }
  for (let k=0;k<nodes.length;k++){
    const b = nodes[k];
    try{
      if (b.tagName==='BUTTON' || b.tagName==='INPUT') b.disabled = !!flag;
      b.style.pointerEvents = flag ? 'none' : '';
      b.style.opacity = flag ? '0.55' : '';
      b.style.cursor = flag ? 'not-allowed' : '';
      b.setAttribute('aria-disabled', flag?'true':'false');
    }catch(_){}
  }
}

function applyCheckoutInterlock(){
  setCheckoutDisabled(!isReadyForCheckout());

  if (_interlockBound) return;
  _interlockBound = true;

  document.addEventListener('click', function(e){
    const t = e.target && e.target.closest ? e.target.closest('#btnCheckout, #btnCheckoutBar, #btnCheckoutMobile, [data-checkout]') : null;
    if (!t) return;
    if (isReadyForCheckout()) return;

    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    toast('Ongkir belum terhitung. Mohon tunggu…');

    try{ if (window.__shipping && typeof window.__shipping.requestQuoteNow==='function') window.__shipping.requestQuoteNow(8000); }catch(_){}
  }, true);

  setInterval(function(){ setCheckoutDisabled(!isReadyForCheckout()); }, 400);
  window.addEventListener('shipping:updated', function(){ setCheckoutDisabled(!isReadyForCheckout()); });
  window.addEventListener('shipping:quote:start', function(){ setCheckoutDisabled(true); });
  window.addEventListener('shipping:quote:end',   function(){ setCheckoutDisabled(!isReadyForCheckout()); });
}

// ================= Bindings & Init =================
function bindEvents(){
  const b1 = byId('btnShipMap');  if (b1) b1.addEventListener('click', initMapAndPick);
  const b2 = byId('btnShipAuto'); if (b2) b2.addEventListener('click', async function(){
    try{
      const p=await geolocateMe(); setDestination(p.lat,p.lng);
      try{ const rt=await osrmRoute(STORE,p); mergeShipping({ route:rt, _last_delivery_route:rt }); renderSummary(); }catch(_){}
    }catch(_){ toast('Gagal akses lokasi (butuh HTTPS & izin).',2200); }
  });

  const bm1 = byId('btnShipMap_m');  if (bm1) bm1.addEventListener('click', initMapAndPick);
  const bm2 = byId('btnShipAuto_m'); if (bm2) bm2.addEventListener('click', async function(){
    try{
      const p=await geolocateMe(); setDestination(p.lat,p.lng);
      try{ const rt=await osrmRoute(STORE,p); mergeShipping({ route:rt, _last_delivery_route:rt }); renderSummary(); }catch(_){}
    }catch(_){ toast('Gagal akses lokasi (butuh HTTPS & izin).',2200); }
  });

  const md = byId('modeDelivery');   if (md)  md.addEventListener('click', function(){ setMode('delivery'); });
  const mp = byId('modePickup');     if (mp)  mp.addEventListener('click', function(){ setMode('pickup'); });
  const mdm = byId('modeDelivery_m');if (mdm) mdm.addEventListener('click', function(){ setMode('delivery'); });
  const mpm = byId('modePickup_m');  if (mpm) mpm.addEventListener('click', function(){ setMode('pickup'); });

  bindWeightControls();
  bindPickupTime();

  window.addEventListener('shipping:updated', renderSummary);
}

function init(){
  injectStyles();
  injectCartUI();
  injectMobileUI();
  ensureFlagsUI();
  bindEvents();
  applyCheckoutInterlock();

  // Render awal (pakai TZ toko / server clock bila ada)
  renderFlagsFromBreakdown();

  // Ambil config & clock server → render ulang (potensi beda nightFrom/To dilindungi hysteresis)
  loadServerConfig().then(function(){
    renderFlagsFromBreakdown();
  });

  // Refresh jam server & ikon tiap 15 dtk
  setInterval(async function(){
    await refreshServerClock();
    renderFlagsFromBreakdown();
  }, 15000);

  // Saat tab fokus lagi → segarkan clock + ikon
  document.addEventListener('visibilitychange', function(){
    if (!document.hidden) { refreshServerClock().then(renderFlagsFromBreakdown); }
  });
}
document.addEventListener('DOMContentLoaded', init);

// ================= Expose for checkout.js & fallback =================
Object.defineProperty(window, '__shipping', {
  value: {
    get fee(){ return Number((State.shipping && State.shipping.fee) || 0); },
    get dest(){ return (State.shipping && State.shipping.dest) || null; },
    get route(){ return (State.shipping && State.shipping.route) || null; },
    get quote(){ return (State.shipping && State.shipping.quote) || null; },
    get address(){ return (State.shipping && State.shipping.address) || null; },
    get mode(){ return (State.shipping && State.shipping.mode) || 'delivery'; },
    get pickup_time(){ return (State.shipping && State.shipping.pickup_time) || null; },

    isReadyForCheckout: isReadyForCheckout,

    requestQuoteNow: function(timeoutMs){
      return new Promise(function(resolve){
        var done=false;
        function finish(){ if(!done){ done=true; resolve(); } }
        try{
          if (_quoteRunning){ /* sudah jalan */ }
          else { quoteIfReady(0); }
        }catch(_){}
        var t = setTimeout(finish, Math.max(1000, Number(timeoutMs)||6000));
        window.addEventListener('shipping:quote:end', function h(){
          try{ clearTimeout(t); }catch(_){}
          window.removeEventListener('shipping:quote:end', h);
          finish();
        });
      });
    }
  },
  writable: false, enumerable: false, configurable: false
});
