'use strict';
// shipping.js — ongkir + alamat + mode Antar/Pickup (pickup gratis, min 30 menit)

import { byId, toast, money } from './utils.js';
import { State } from './state.js';

const WORKER_BASE = 'https://adamentai-ongkir-proxy.msabiq-stan.workers.dev';
const STORE       = { lat: 3.574856, lng: 98.702053 }; // Medan
const OSRM_BASE   = 'https://router.project-osrm.org';

/* ===== Helpers ===== */
const H = (h)=>{ const d=document.createElement('div'); d.innerHTML=h.trim(); return d.firstElementChild; };
const setTextIf = (id, txt)=>{ const el = byId(id); if (el) el.textContent = txt; };

function toHHMM(d){ return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
function earliestPickupDate(){ const d=new Date(); d.setMinutes(d.getMinutes()+30); d.setSeconds(0); d.setMilliseconds(0); return d; }

/* Haversine distance (km) */
function distKm(lat1, lon1, lat2, lon2){
  const R=6371, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

/* ===== Styles ===== */
function injectStyles(){
  if (document.getElementById('shipStyles')) return;
  const s = document.createElement('style'); s.id='shipStyles';
  s.textContent = `
    .ship-dest-box{font-size:12px;line-height:1.35;background:#0e1a33;color:#e5efff;
      border:1px solid var(--line);padding:8px 10px;border-radius:12px}
    .ship-pill{display:inline-block;padding:6px 10px;border-radius:999px;background:#0b4c8a;
      color:#e6f3ff;font-size:12px;margin-top:8px}
    .wg-chip{padding:4px 10px;border-radius:999px;border:1px solid var(--line);
      background:#0e1a33;color:#e5efff;cursor:pointer;font-size:12px}
    .wg-chip.is-on{background:#1e40af;color:#ffffff;border-color:#1e40af}
    .wg-input{width:76px;font-size:12px;padding:6px 10px;border-radius:999px;
      background:#0e1a33;color:#e5efff;border:1px solid var(--line);outline:none}
    .wg-input:focus{border-color:#1e40af;box-shadow:0 0 0 2px rgba(30,64,175,.28)}
    /* Lebarkan input time agar angka tidak tertutup chip */
    #pickupTime, #pickupTime_m{ width:128px; min-width:128px; }
    .ship-mode{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}

    #cartDrawer .quantity button,
    #cartDrawer .qty button,
    #cartDrawer button.qty-minus,
    #cartDrawer button.qty-plus{
      background:#0e1a33;border:1px solid var(--line);color:#e5efff;border-radius:9999px;font-size:12px;
      padding:6px 10px;line-height:1;min-width:34px;min-height:34px;display:inline-flex;align-items:center;justify-content:center;
      transition:transform .08s ease, background .15s ease, border-color .15s ease;
    }
    #cartDrawer .quantity button:hover,
    #cartDrawer .qty button:hover,
    #cartDrawer button.qty-minus:hover,
    #cartDrawer button.qty-plus:hover{ background:#132244;border-color:#1e40af; }
    #cartDrawer .quantity input[type="number"],
    #cartDrawer .qty input[type="number"],
    #cartDrawer input.qty-input{
      background:#0e1a33;border:1px solid var(--line);color:#e5efff;border-radius:12px;font-size:12px;padding:6px 10px;width:48px;text-align:center;
    }
    #cartDrawer .drawer__items .item-title{font-size:13px;line-height:1.3}
  `;
  document.head.appendChild(s);
}

/* ===== Leaflet (lazy) ===== */
function ensureLeaflet(){
  return new Promise((resolve,reject)=>{
    if (window.L) return resolve();
    const css=document.createElement('link'); css.rel='stylesheet';
    css.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    css.integrity='sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; css.crossOrigin='';
    document.head.appendChild(css);
    const js=document.createElement('script'); js.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.integrity='sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='; js.crossOrigin='';
    js.onload=()=>resolve(); js.onerror=()=>reject(new Error('Leaflet load failed'));
    document.head.appendChild(js);
  });
}

/* ===== Inject UI helpers ===== */
function insertAfter(refNode, newNode){
  if (!refNode || !refNode.parentElement) return;
  if (refNode.nextSibling) refNode.parentElement.insertBefore(newNode, refNode.nextSibling);
  else refNode.parentElement.appendChild(newNode);
}

/* ===== Inject UI (desktop) ===== */
function injectCartUI(){
  const disc = byId('cartDiscount');
  const anchorRow = disc && disc.closest ? disc.closest('.row') : null;
  const fallbackContainer = document.querySelector('aside.cart .summary') || (anchorRow && anchorRow.parentElement) || document.body;

  // Baris Ongkir (sekali saja)
  if (!byId('cartShipping') && anchorRow){
    insertAfter(anchorRow, H(`<div class="row"><span>Ongkir</span><strong id="cartShipping" data-cart-shipping>Rp0</strong></div>`));
  }

  // Kontrol mode + alamat + berat + pickup
  if (!byId('shipDestLabel')){
    const ctl = H(`
      <div style="margin-top:8px">
        <div class="ship-mode">
          <button id="modeDelivery" class="wg-chip is-on" type="button">Antar</button>
          <button id="modePickup"   class="wg-chip"       type="button">Ambil sendiri</button>
        </div>

        <div class="ship-dest-box"><span id="shipDestLabel">Pilih lokasi pengantaran</span></div>

        <div id="deliveryBox" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
          <button id="btnShipMap"  class="btn btn--ghost" type="button">Pilih di Peta</button>
          <button id="btnShipAuto" class="btn btn--ghost" type="button">Lokasi saya</button>

          <div style="display:flex;align-items:center;gap:6px;font-size:12px">
            <span style="opacity:.8">Berat</span>
            <div id="wgChips" style="display:flex;gap:6px">
              <button class="wg-chip" data-wg="1" type="button">1 kg</button>
              <button class="wg-chip" data-wg="2" type="button">2 kg</button>
              <button class="wg-chip" data-wg="3" type="button">3 kg</button>
            </div>
            <input id="shipWeight" class="wg-input" type="number" step="0.1" min="0.1" value="1" />
          </div>
        </div>

        <div id="pickupBox" style="display:none;margin-top:8px">
          <label style="font-size:12px;opacity:.85;display:block;margin-bottom:4px">Waktu ambil (≥ 30 menit dari sekarang)</label>
          <input id="pickupTime" class="wg-input" type="time" />
        </div>

        <div id="shipPill" class="ship-pill"></div>
      </div>
    `);
    if (anchorRow) insertAfter(anchorRow, ctl); else fallbackContainer.appendChild(ctl);
  }
}

/* ===== Inject UI (mobile) ===== */
function injectMobileUI(){
  const sum = document.querySelector('#cartDrawer .drawer-summary');
  if (sum && !sum.querySelector('[data-cart-shipping]')){
    sum.appendChild(H(`<div><span>Ongkir</span> <span data-cart-shipping>Rp0</span></div>`));
  }

  const cont = document.querySelector('#cartDrawer .drawer__customer');
  if (cont && !byId('shipMini_m')){
    cont.prepend(H(`
      <div id="shipMini_m" style="margin:8px 0">
        <div class="ship-mode">
          <button id="modeDelivery_m" class="wg-chip is-on" type="button">Antar</button>
          <button id="modePickup_m"   class="wg-chip"       type="button">Ambil sendiri</button>
        </div>

        <div class="ship-dest-box"><span id="shipDestLabel_m">Pilih lokasi pengantaran</span></div>
        <div id="deliveryBox_m" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
          <button id="btnShipMap_m"  class="btn btn--ghost" type="button">Pilih di Peta</button>
          <button id="btnShipAuto_m" class="btn btn--ghost" type="button">Lokasi saya</button>

          <div style="display:flex;align-items:center;gap:6px;font-size:12px">
            <span style="opacity:.8">Berat</span>
            <div id="wgChips_m" style="display:flex;gap:6px">
              <button class="wg-chip" data-wg="1" type="button">1 kg</button>
              <button class="wg-chip" data-wg="2" type="button">2 kg</button>
              <button class="wg-chip" data-wg="3" type="button">3 kg</button>
            </div>
            <input id="shipWeight_m" class="wg-input" type="number" step="0.1" min="0.1" value="1" />
          </div>
        </div>

        <div id="pickupBox_m" style="display:none;margin-top:8px">
          <label style="font-size:12px;opacity:.85;display:block;margin-bottom:4px">Waktu ambil (≥ 30 menit dari sekarang)</label>
          <input id="pickupTime_m" class="wg-input" type="time" />
        </div>

        <div id="shipPill_m" class="ship-pill"></div>
      </div>`));
  }
}

/* ===== HTTP helpers ===== */
async function fetchJson(url, opts={}, tries=1){
  for (let i=0;i<tries;i++){
    try{
      const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(),9000);
      const r=await fetch(url,{...opts,signal:ctl.signal}); clearTimeout(to);
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){ if(i===tries-1) throw e; await new Promise(r=>setTimeout(r,300)); }
  }
}

/* ===== Geocoding ===== */
async function geocodeNearby(q){
  const u=new URL(WORKER_BASE+'/geocode');
  u.searchParams.set('q',q); u.searchParams.set('limit','8'); u.searchParams.set('lang','id');
  u.searchParams.set('lat',String(STORE.lat)); u.searchParams.set('lon',String(STORE.lng));
  u.searchParams.set('radius_km','10');
  try{ return await fetchJson(u.toString(),{},2); }catch{ return []; }
}
async function reverseGeocode(lat,lng){
  try{ return await fetchJson(`${WORKER_BASE}/reverse?lat=${lat}&lon=${lng}&lang=id`,{},2); }
  catch{ return null; }
}

/* ===== Modal Peta ===== */
function injectModal(){
  if (byId('shipModal')) return;
  document.body.appendChild(H(`
    <div id="shipModal" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:9999">
      <div style="background:#0f172a;color:#e5efff;border:1px solid #1f2a44;border-radius:14px;width:min(92vw,960px);padding:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <strong>Pilih lokasi tujuan</strong>
          <button id="shipClose" class="btn btn--ghost" type="button">Tutup</button>
        </div>

        <div style="position:relative">
          <div id="shipMap" style="height:460px;border-radius:12px;overflow:hidden"></div>
          <div style="position:absolute;left:12px;right:12px;top:12px;display:flex;gap:8px;z-index:1000;pointer-events:auto">
            <input id="shipMapSearch" class="input" placeholder="Cari alamat / tempat (≤ 10 km dari toko)..." autocomplete="off" style="flex:1">
            <button id="shipMapMe" class="btn btn--ghost" type="button">Lokasi saya</button>
          </div>
          <div id="shipMapSug" style="position:absolute;left:12px;right:12px;top:56px;max-height:190px;overflow:auto;z-index:1001;pointer-events:auto"></div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:8px">
          <button id="shipUseHere" class="btn" type="button">Pakai Titik Ini</button>
        </div>
      </div>
    </div>
  `));
}
const openModal = ()=> (byId('shipModal').style.display='flex');
const closeModal= ()=> { const s=byId('shipMapSug'); if(s) s.innerHTML=''; byId('shipModal').style.display='none'; };

let routeLayer=null, marker=null, mapInst=null, _mapBound=false;

function ensureMapMarker(lat,lng){
  if(!marker){
    marker = L.marker([lat,lng],{draggable:true}).addTo(mapInst);
    marker.on('dragend', async e=>{
      const p=e.target.getLatLng();
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
    // Pindahkan zoom control ke kanan-bawah agar tidak ketutup search box
    mapInst = L.map('shipMap', { zoomControl: false }).setView([STORE.lat, STORE.lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OSM'
    }).addTo(mapInst);
    L.control.zoom({ position: 'bottomright' }).addTo(mapInst);

    L.marker([STORE.lat, STORE.lng]).addTo(mapInst).bindPopup('Origin (Toko)');
  }else{
    setTimeout(()=>mapInst.invalidateSize(),60);
  }
  if(!_mapBound){
    _mapBound = true;
    mapInst.on('click', e => {
      ensureMapMarker(e.latlng.lat, e.latlng.lng);
      handlePicked(e.latlng.lat, e.latlng.lng);
      setDestination(e.latlng.lat, e.latlng.lng);
    });
    byId('shipUseHere').addEventListener('click', () => {
      if(!marker){ toast('Klik peta untuk pilih titik'); return; }
      const p = marker.getLatLng();
      setDestination(p.lat, p.lng);
      closeModal();
    });
    byId('shipClose').addEventListener('click', closeModal);
    byId('shipMapMe').addEventListener('click', async () => {
      try{
        const p = await geolocateMe();
        mapInst.setView([p.lat, p.lng], 16);
        ensureMapMarker(p.lat, p.lng);
        await handlePicked(p.lat, p.lng);
        setDestination(p.lat, p.lng);
      }catch{
        toast('Gagal akses lokasi (butuh HTTPS & izin).', 2200);
      }
    });
  }
}

async function osrmRoute(origin,dest){
  const u=`${OSRM_BASE}/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
  const r=await fetch(u); if(!r.ok) throw new Error('OSRM HTTP '+r.status);
  const d=await r.json(); const rt=d.routes?.[0]; if(!rt) throw new Error('OSRM no route');
  return { distance_km:rt.distance/1000, eta_min:Math.round(rt.duration/60), geojson:rt.geometry };
}
async function handlePicked(lat,lng){
  if(routeLayer){ mapInst.removeLayer(routeLayer); routeLayer=null; }
  try{
    const rt=await osrmRoute(STORE,{lat,lng});
    const gj={type:'Feature',properties:{},geometry:rt.geojson};
    routeLayer=L.geoJSON(gj,{style:{color:'#38bdf8',weight:4,opacity:.95}}).addTo(mapInst);
    mapInst.fitBounds(routeLayer.getBounds(),{padding:[20,20]});
    State.shipping={...(State.shipping||{}),_picked:{lat,lng},route:rt,_last_delivery_route:rt};
    renderSummary();
  }catch{}
}

/* ===== Search in modal (≤ 10 km) ===== */
function bindMapSearch(){
  const inp=byId('shipMapSearch'), sug=byId('shipMapSug');
  if(!inp || inp.dataset.bound) return; inp.dataset.bound='1';
  let t=null;
  inp.addEventListener('input', ()=>{
    const q=inp.value.trim(); clearTimeout(t);
    if(q.length<3){ sug.innerHTML=''; return; }
    t=setTimeout(async ()=>{
      sug.innerHTML='<div class="note" style="padding:6px 8px;border-radius:10px;background:#0e1a33;border:1px solid var(--line)">Mencari…</div>';
      const raw=await geocodeNearby(q).catch(()=>[]);
      const list=raw.filter(r=>distKm(STORE.lat,STORE.lng,r.lat,r.lng)<=10);
      if(!list.length){ sug.innerHTML='<div class="note" style="padding:6px 8px;border-radius:10px;background:#0e1a33;border:1px solid var(--line)">Tidak ada hasil dalam radius 10 km</div>'; return; }
      [...list.keys()].forEach(i=>{
        // build items
      });
      sug.innerHTML=list.map((r,i)=>`
        <div data-i="${i}" style="padding:6px 8px;border:1px solid var(--line);border-radius:10px;margin:4px 0;cursor:pointer;background:#0e1a33;color:#e5efff">
          ${r.label}
        </div>`).join('');
      [...sug.querySelectorAll('[data-i]')].forEach(el=>{
        el.addEventListener('click', async ()=>{
          const p=list[+el.dataset.i]; if(!p) return;
          mapInst.setView([p.lat,p.lng],16);
          ensureMapMarker(p.lat,p.lng);
          await handlePicked(p.lat,p.lng);
          setDestination(p.lat,p.lng,p.label);
          sug.innerHTML='';
        });
      });
    },280);
  });
}

/* ===== Mode (delivery / pickup) ===== */
function setMode(mode){
  const isPickup = mode === 'pickup';

  // Toggle UI
  const md  = byId('modeDelivery'); const mp  = byId('modePickup');
  const mdm = byId('modeDelivery_m'); const mpm = byId('modePickup_m');
  if (md)  md.classList.toggle('is-on', !isPickup);
  if (mp)  mp.classList.toggle('is-on', isPickup);
  if (mdm) mdm.classList.toggle('is-on', !isPickup);
  if (mpm) mpm.classList.toggle('is-on', isPickup);

  const dBox  = byId('deliveryBox');  const pBox  = byId('pickupBox');
  const dBoxm = byId('deliveryBox_m');const pBoxm = byId('pickupBox_m');
  if (dBox)  dBox.style.display  = isPickup ? 'none' : 'flex';
  if (dBoxm) dBoxm.style.display = isPickup ? 'none' : 'flex';
  if (pBox)  pBox.style.display  = isPickup ? 'block' : 'none';
  if (pBoxm) pBoxm.style.display = isPickup ? 'block' : 'none';

  if (isPickup){
    // simpan destinasi last-delivery, lalu set pickup
    const prev = State.shipping || {};
    const minDate = earliestPickupDate();
    const hhmm = toHHMM(minDate);
    const t1 = byId('pickupTime'); const t2 = byId('pickupTime_m');

    if (t1){ t1.min = hhmm; if (!t1.value) t1.value = hhmm; }
    if (t2){ t2.min = hhmm; if (!t2.value) t2.value = hhmm; }

    State.shipping = {
      ...prev,
      _last_delivery_dest   : prev.dest || prev._last_delivery_dest || null,
      _last_delivery_address: (prev.address && prev.address !== 'Ambil di Toko') ? prev.address : (prev._last_delivery_address || null),
      _last_delivery_route  : prev.route || prev._last_delivery_route || null,

      mode: 'pickup',
      fee: 0,
      dest: null,
      address: 'Ambil di Toko',
      pickup_time: (t1 && t1.value) || (t2 && t2.value) || hhmm
    };

    setTextIf('shipDestLabel','Ambil di Toko');
    setTextIf('shipDestLabel_m','Ambil di Toko');
  } else {
    // kembali ke antar -> pulihkan alamat / kosongkan kalau belum pernah pilih
    const prev = State.shipping || {};
    const lastDest  = prev._last_delivery_dest   || null;
    const lastAddr  = prev._last_delivery_address|| null;
    const lastRoute = prev._last_delivery_route  || null;

    State.shipping = {
      ...prev,
      mode  : 'delivery',
      dest  : lastDest,
      address: lastAddr || null,               // jangan pakai "Ambil di Toko"
      route : lastRoute || null,
      pickup_time: null,
      fee: lastDest ? prev.fee : 0
    };

    setTextIf('shipDestLabel', lastAddr || 'Pilih lokasi pengantaran');
    setTextIf('shipDestLabel_m', lastAddr || 'Pilih lokasi pengantaran');

    // kosongkan pill bila belum ada tujuan
    if (!lastDest){
      setTextIf('shipPill',''); setTextIf('shipPill_m','');
    } else {
      // re-quote supaya pill langsung update
      quoteIfReady(0);
    }
  }

  renderSummary();
  window.dispatchEvent(new Event('shipping:updated'));
  import('./cart.js').then(m=>m.renderCart?.()).catch(()=>{});
}

/* ===== Tujuan & auto-quote ===== */
function setDestination(lat,lng,labelText){
  const prev=State.shipping?._picked; const same=prev && Math.abs(prev.lat-lat)<1e-6 && Math.abs(prev.lng-lng)<1e-6;
  const route=same ? State.shipping.route : null;

  // catat tujuan & simpan sebagai "last delivery"
  State.shipping={
    ...(State.shipping||{}),
    dest:{lat:Number(lat),lng:Number(lng)},
    route,
    mode:'delivery',
    _last_delivery_dest:{lat:Number(lat),lng:Number(lng)}
  };

  const apply=(txt)=>{
    State.shipping={...(State.shipping||{}),address:txt,_last_delivery_address:txt};
    setTextIf('shipDestLabel',txt); setTextIf('shipDestLabel_m',txt);
    renderSummary(); quoteIfReady(0);
  };
  if(labelText) apply(labelText);
  else reverseGeocode(lat,lng).then(a=>apply(a?.label||`${lat.toFixed(6)}, ${lng.toFixed(6)}`))
                              .catch(()=>apply(`${lat.toFixed(6)}, ${lng.toFixed(6)}`));

  setMode('delivery'); // pastikan mode antar
  window.dispatchEvent(new Event('shipping:updated'));
  import('./cart.js').then(m=>m.renderCart?.()).catch(()=>{});
}

/* ===== Berat controls ===== */
function bindWeightControls(){
  const chipsD=document.querySelectorAll('#wgChips .wg-chip');
  const chipsM=document.querySelectorAll('#wgChips_m .wg-chip');
  function mark(nodes,val){ nodes.forEach(n=> n.classList.toggle('is-on', Number(n.dataset.wg)===Number(val))); }
  function setWeight(val,src){
    val=Math.max(0.1, Number(val)||1);
    const iD=byId('shipWeight'); const iM=byId('shipWeight_m');
    if(iD) iD.value=String(val); if(iM) iM.value=String(val);
    mark(chipsD,val); mark(chipsM,val);
    if(src!=='init') quoteIfReady();
  }
  chipsD.forEach(b=> b.addEventListener('click', ()=> setWeight(b.dataset.wg)));
  chipsM.forEach(b=> b.addEventListener('click', ()=> setWeight(b.dataset.wg)));
  byId('shipWeight')  ?.addEventListener('input', ()=> setWeight(byId('shipWeight').value));
  byId('shipWeight_m')?.addEventListener('input', ()=> setWeight(byId('shipWeight_m').value));
  setWeight(1,'init');
}

/* ===== Pickup time controls ===== */
function bindPickupTime(){
  function apply(val){
    const minHHMM = toHHMM(earliestPickupDate());
    const ok = val && val >= minHHMM;
    if (!ok){
      toast('Waktu ambil minimal 30 menit dari sekarang');
      return false;
    }
    State.shipping = { ...(State.shipping||{}), pickup_time: val, mode:'pickup', fee:0, dest:null, address:'Ambil di Toko' };
    renderSummary();
    window.dispatchEvent(new Event('shipping:updated'));
    import('./cart.js').then(m=>m.renderCart?.()).catch(()=>{});
    return true;
  }
  const t1 = byId('pickupTime'); const t2 = byId('pickupTime_m');
  const min = toHHMM(earliestPickupDate());
  if (t1){ t1.min = min; if (!t1.value) t1.value = min; t1.addEventListener('change', ()=> apply(t1.value)); }
  if (t2){ t2.min = min; if (!t2.value) t2.value = min; t2.addEventListener('change', ()=> apply(t2.value)); }
}

/* ===== Quote ===== */
let _quoteT=null;
function quoteIfReady(delay=400){ clearTimeout(_quoteT); _quoteT=setTimeout(()=>doQuote().catch(()=>{}),delay); }

async function post(path,payload){
  const pillD=byId('shipPill'), pillM=byId('shipPill_m');
  if(pillD) pillD.textContent='Menghitung…'; if(pillM) pillM.textContent='Menghitung…';
  const r=await fetch(WORKER_BASE+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await r.json().catch(()=>({})); if(!r.ok||data?.error) throw new Error(data?.error||r.statusText||'HTTP error');
  return data;
}
async function geolocateMe(){
  return new Promise((res,rej)=>{
    if(!navigator.geolocation) return rej(new Error('Geolocation tidak didukung'));
    navigator.geolocation.getCurrentPosition(p=>res({lat:p.coords.latitude,lng:p.coords.longitude}),rej,{enableHighAccuracy:true,timeout:8000});
  });
}
async function doQuote(){
  const s=State.shipping||{};
  if (s.mode === 'pickup'){
    State.shipping={...s, fee:0};
    renderSummary();
    import('./cart.js').then(m=>m.renderCart?.()).catch(()=>{});
    return;
  }
  const d=s.dest; if(!d) return;
  if(!s.route?.distance_km){
    try{ const rt=await osrmRoute(STORE,d); State.shipping={...s,route:rt,_last_delivery_route:rt}; renderSummary(); }catch{}
  }
  const kg = Number(byId('shipWeight')?.value || byId('shipWeight_m')?.value || 1);
  const dist = Number(State.shipping?.route?.distance_km || 0);
  const dd=new Date();
  const payload = {
    origin: STORE,
    dest: { lat:d.lat, lng:d.lng },
    weight_kg: kg,
    order_time_local: String(dd.getHours()).padStart(2,'0')+':'+String(dd.getMinutes()).padStart(2,'0'),
    rain: false,
    distance_km_override: dist>0 ? Number(dist.toFixed(2)) : undefined,
    address_text: State.shipping?.address || ''
  };
  let q; try{ q=await post('/quote',payload); }catch{ return; }
  if(q.deliverable===false){
    State.shipping={...State.shipping,fee:0,quote:q,eta_min:null};
    const msg=q.reason||'Di luar jangkauan'; setTextIf('shipPill',msg); setTextIf('shipPill_m',msg); toast(msg,2200);
  }else{
    State.shipping={...State.shipping,fee:q.price,quote:q,
      eta_min:(q.eta_min ?? State.shipping?.route?.eta_min ?? null),
      distance_km:(q.distance_km ?? (Number.isFinite(dist)?dist:null)),
      breakdown:q.breakdown||null};
    renderSummary();
  }
  import('./cart.js').then(m=>m.renderCart?.()).catch(()=>{});
}

function renderSummary(){
  const s=State.shipping||{};
  if(s.mode==='pickup'){
    setTextIf('shipDestLabel','Ambil di Toko');
    setTextIf('shipDestLabel_m','Ambil di Toko');
    const when = s.pickup_time ? `• ${s.pickup_time}` : '';
    const pill=`Ambil sendiri • Gratis ${when}`.trim();
    setTextIf('shipPill',pill); setTextIf('shipPill_m',pill);
    return;
  }
  // mode antar
  const addr = (s.address && s.address !== 'Ambil di Toko') ? s.address : '';
  setTextIf('shipDestLabel', addr || 'Pilih lokasi pengantaran');
  setTextIf('shipDestLabel_m', addr || 'Pilih lokasi pengantaran');

  if (!addr || !s.dest){
    setTextIf('shipPill',''); setTextIf('shipPill_m','');
    return;
  }
  const km = s.route?.distance_km ? `≈ ${s.route.distance_km.toFixed(2)} km` : '';
  const fee= (typeof s.fee==='number') ? `• ${money(s.fee)}` : '';
  const pillTxt=[km,fee].filter(Boolean).join(' ');
  setTextIf('shipPill',pillTxt); setTextIf('shipPill_m',pillTxt);
}

/* ===== Bindings & Init ===== */
function bindEvents(){
  byId('btnShipMap') ?.addEventListener('click', initMapAndPick);
  byId('btnShipAuto')?.addEventListener('click', async ()=>{
    try{
      const p=await geolocateMe(); setDestination(p.lat,p.lng);
      try{ const rt=await osrmRoute(STORE,p); State.shipping={...(State.shipping||{}),route:rt,_last_delivery_route:rt}; renderSummary(); }catch{}
    }catch{ toast('Gagal akses lokasi (butuh HTTPS & izin).',2200); }
  });

  byId('btnShipMap_m') ?.addEventListener('click', initMapAndPick);
  byId('btnShipAuto_m')?.addEventListener('click', async ()=>{
    try{
      const p=await geolocateMe(); setDestination(p.lat,p.lng);
      try{ const rt=await osrmRoute(STORE,p); State.shipping={...(State.shipping||{}),route:rt,_last_delivery_route:rt}; renderSummary(); }catch{}
    }catch{ toast('Gagal akses lokasi (butuh HTTPS & izin).',2200); }
  });

  // mode
  byId('modeDelivery')  ?.addEventListener('click', ()=> setMode('delivery'));
  byId('modePickup')    ?.addEventListener('click', ()=> setMode('pickup'));
  byId('modeDelivery_m')?.addEventListener('click', ()=> setMode('delivery'));
  byId('modePickup_m')  ?.addEventListener('click', ()=> setMode('pickup'));

  // berat & pickup time
  bindWeightControls();
  bindPickupTime();

  window.addEventListener('shipping:updated', renderSummary);

  // default mode
  setMode((State.shipping && State.shipping.mode) || 'delivery');
}

function init(){
  injectStyles();
  injectCartUI();
  injectMobileUI();
  bindEvents();
}
document.addEventListener('DOMContentLoaded', init);

/* ===== Expose for checkout.js ===== */
window.__shipping = {
  get fee(){ return Number(State.shipping?.fee || 0); },
  get dest(){ return State.shipping?.dest || null; },
  get route(){ return State.shipping?.route || null; },
  get quote(){ return State.shipping?.quote || null; },
  get address(){ return State.shipping?.address || null; },
  get mode(){ return State.shipping?.mode || 'delivery'; },
  get pickup_time(){ return State.shipping?.pickup_time || null; }
};
