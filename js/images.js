'use strict';
// Image helpers: Google Drive multi-candidate + optional Cloudflare proxy
// + lightweight caches for card nodes & resolved image URLs

import { CF_IMAGE_PROXY } from './config.js';

const PLACEHOLDER_IMG =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="%23f3f4f6"/><text x="50%" y="50%" font-family="Arial, sans-serif" font-size="20" fill="%239ca3af" text-anchor="middle" dominant-baseline="middle">No image</text></svg>';

/** Try to extract a Drive file id from various URL forms or a raw id */
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
  for (const re of patterns){
    const m = s.match(re);
    if (m) return m[1];
  }
  try {
    const url = new URL(s);
    const id = url.searchParams.get('id');
    if (id) return id;
  } catch(_){/* not a URL */}
  return '';
}

/** Optionally wrap URL with Cloudflare Image Resizing proxy */
function proxyIfNeeded(u){
  if (!CF_IMAGE_PROXY) return u;
  // format 1: ...?u=${url}
  if (CF_IMAGE_PROXY.includes('${url}')) return CF_IMAGE_PROXY.replace('${url}', encodeURIComponent(u));
  // format 2: base/ + encoded url
  if (CF_IMAGE_PROXY.endsWith('/')) return CF_IMAGE_PROXY + encodeURIComponent(u);
  return CF_IMAGE_PROXY + '/' + encodeURIComponent(u);
}

/** Build candidate URLs for a Drive id or a direct URL; last fallback is placeholder */
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
  ] : [uOrId || '', PLACEHOLDER_IMG];
  return raw.map(proxyIfNeeded);
}

// Caches
const CARD_CACHE = new Map(); // itemId -> DOM node (kartu)
const IMG_OK_URL = new Map(); // key (itemId atau url asli) -> url kandidat yang berhasil

/** Preconnect/DNS-prefetch to speed up first image load */
function addPreconnectHosts(){
  const hosts = new Set([
    'https://lh3.googleusercontent.com',
    'https://drive.usercontent.google.com',
    'https://drive.google.com'
  ]);
  if (CF_IMAGE_PROXY){
    try{
      const u = CF_IMAGE_PROXY.includes('http')
        ? new URL(CF_IMAGE_PROXY.replace('${url}', 'https://x'))
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

/** Warm a handful of images into the browser cache (best-effort) */
function prewarmImages(items, limit=12){
  (items||[]).slice(0, limit).forEach(m=>{
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

export {
  PLACEHOLDER_IMG,
  extractDriveId,
  proxyIfNeeded,
  driveUrlCandidates,
  CARD_CACHE,
  IMG_OK_URL,
  addPreconnectHosts,
  prewarmImages
};
