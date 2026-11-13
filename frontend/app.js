// SPDX-License-Identifier: MIT
// Frontend dashboard — vanilla JS, fetch NGINX API (http://localhost:80 default)
//
// API_BASE comes from ?api=, localStorage, or the default. Only http(s) URLs
// are accepted, and only same-origin/same-host or explicitly allowlisted
// origins are persisted. This prevents javascript:/data: injection and stops a
// malicious link from writing an arbitrary API origin into localStorage.

const DEFAULT_API_BASE = 'http://localhost:80';
const STATIC_API_ALLOWLIST = [
  'http://localhost:80',
  'http://127.0.0.1:80',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3004',
];

function apiAllowlist() {
  const configured = Array.isArray(window.ERP_API_ALLOWLIST) ? window.ERP_API_ALLOWLIST : [];
  return new Set([...STATIC_API_ALLOWLIST, ...configured]);
}

function normalizeApiBase(value) {
  if (!value || typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value, location.origin);
  } catch (_err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const sameHost = url.hostname === location.hostname;
  if (!sameHost && !apiAllowlist().has(url.origin)) return null;
  return url.origin;
}

const API_BASE = (() => {
  const params = new URLSearchParams(location.search);
  const candidates = [params.get('api'), localStorage.getItem('api_base'), DEFAULT_API_BASE];
  for (const candidate of candidates) {
    const normalized = normalizeApiBase(candidate);
    if (normalized) {
      // Never keep a value that failed validation.
      try {
        localStorage.setItem('api_base', normalized);
      } catch (_err) {
        // Storage can be unavailable (private mode); the page still works.
      }
      return normalized;
    }
  }
  return DEFAULT_API_BASE;
})();

const $ = s => document.querySelector(s);
const escapeHtml = value =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
const toast = (msg, isErr = true) => {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? '' : '');
  setTimeout(() => (t.className = 'toast'), 4000);
};

async function api(path, opts = {}) {
  const url = /^https?:\/\//i.test(path) ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const headers = Object.fromEntries(res.headers.entries());
  return { ok: res.ok, status: res.status, body, headers, text };
}

function renderHealth() {
  Promise.all([
    api('/health'),
    api('/api/v1/productos/health'),
    api('/api/v1/ordenes/health'),
    api('/api/v1/stock/health'),
    api('/api/v1/productos/health/details').catch(() => ({ ok: false })),
  ]).then(([ng, p, o, s, d]) => {
    const safeApiBase = escapeHtml(API_BASE);
    const pool = d.body?.pool ? escapeHtml(JSON.stringify(d.body.pool)) : '—';
    $('#health').innerHTML = `
      <div class="kv">
        <b>nginx</b><span class="${ng.ok ? 'ok' : 'err'}">${ng.status} ${ng.ok ? 'ok' : 'fail'}</span>
        <b>productos</b><span class="${p.ok ? 'ok' : 'err'}">${p.status} ${p.body?.status || ''}</span>
        <b>ordenes</b><span class="${o.ok ? 'ok' : 'err'}">${o.status} ${o.body?.status || ''}</span>
        <b>stock</b><span class="${s.ok ? 'ok' : 'err'}">${s.status} ${s.body?.status || ''}</span>
        <b>details pool</b><span class="muted">${pool} uptime ${escapeHtml(d.body?.uptime_s || '—')}s</span>
      </div>
      <div class="muted" style="margin-top:8px">X-Request-Id: ${escapeHtml(ng.headers['x-request-id'] || '—')} • <a href="${safeApiBase}/metrics" target="_blank" rel="noopener noreferrer">/metrics</a> • <a href="${safeApiBase}/api/v1/productos?limit=1" target="_blank" rel="noopener noreferrer">api sample</a></div>
    `;
  });
}

async function loadProductos(page = 1) {
  const limit = 5;
  const r = await api(`/api/v1/productos?page=${page}&limit=${limit}`);
  if (!r.ok) return toast(`productos ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  const total = r.headers['x-total-count'] || r.body.total;
  const hit = r.headers['x-cache'] || '—';
  $('#prodCache').textContent = `X-Cache: ${hit} • X-Total-Count: ${total}`;
  const rows = r.body.data || [];
  $('#prodTable').innerHTML =
    `<tr><th>id</th><th>nombre</th><th>precio</th><th>stock</th></tr>` +
      rows
        .map(
          p => `
    <tr><td>${escapeHtml(p.id)}</td><td>${escapeHtml(p.nombre)}</td><td>${escapeHtml(p.precio)}</td><td>${escapeHtml(p.stock)}</td></tr>
  `
        )
        .join('') || '<tr><td colspan=4 class="muted">vacío</td></tr>';
  // fill select for orden/stock
  const sel = $('#ordenProdId');
  if (sel)
    sel.innerHTML = rows
      .map(
        p =>
          `<option value="${escapeHtml(p.id)}">${escapeHtml(p.id)} — ${escapeHtml(p.nombre.slice(0, 18))} (stock ${escapeHtml(p.stock)})</option>`
      )
      .join('');
  const sel2 = $('#stockProdId');
  if (sel2) sel2.innerHTML = sel.innerHTML;
}

async function createProducto(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    nombre: fd.get('nombre'),
    precio: Number(fd.get('precio')),
    stock: Number(fd.get('stock')),
  };
  const r = await api('/api/v1/productos', { method: 'POST', body: JSON.stringify(payload) });
  if (r.ok) {
    toast(`creado id ${r.body.data.id}`, false);
    loadProductos();
  } else toast(`create producto ${r.status} ${r.text.slice(0, 180)}`);
}

async function loadOrdenes() {
  const r = await api('/api/v1/ordenes?limit=5');
  if (!r.ok) return toast(`ordenes ${r.status}`);
  const rows = r.body.data || [];
  $('#ordenTable').innerHTML =
    `<tr><th>id</th><th>prod</th><th>cant</th><th>total</th><th>BFF</th></tr>` +
      rows
        .map(
          o => `
    <tr><td>${escapeHtml(o.id)}</td><td>${escapeHtml(o.producto_id)}</td><td>${escapeHtml(o.cantidad)}</td><td>${escapeHtml(o.total)}</td><td><button type="button" class="bff-btn" data-orden-id="${Number(o.id)}">include</button></td></tr>
  `
        )
        .join('') || '<tr><td colspan=5 class="muted">vacío</td></tr>';
}

async function createOrden(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    producto_id: Number(fd.get('producto_id')),
    cantidad: Number(fd.get('cantidad')),
    total: Number(fd.get('total')),
  };
  const r = await api('/api/v1/ordenes', { method: 'POST', body: JSON.stringify(payload) });
  if (r.ok) {
    toast(`orden ${r.body.data.id} creada`, false);
    loadOrdenes();
  } else toast(`orden ${r.status} ${r.text.slice(0, 200)}`);
}

async function bff(id) {
  const direct = await api(`/api/v1/ordenes/${id}?include=producto`);
  const viaGateway = await api(`/api/v1/bff/ordenes/${id}`).catch(() => ({
    ok: false,
    status: 'no gateway',
  }));
  $('#bffBox').textContent = JSON.stringify({ direct, gateway: viaGateway }, null, 2);
  if (!direct.ok) toast(`bff direct ${direct.status}`);
}

async function loadStock() {
  const r = await api('/api/v1/stock?limit=5');
  if (!r.ok) return toast(`stock ${r.status}`);
  const rows = r.body.data || [];
  $('#stockTable').innerHTML =
    `<tr><th>id</th><th>prod</th><th>cant</th><th>tipo</th></tr>` +
      rows
        .map(
          s => `
    <tr><td>${escapeHtml(s.id)}</td><td>${escapeHtml(s.producto_id)}</td><td>${escapeHtml(s.cantidad)}</td><td>${escapeHtml(s.tipo)}</td></tr>
  `
        )
        .join('') || '<tr><td colspan=4 class="muted">vacío</td></tr>';
}

async function createStock(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    producto_id: Number(fd.get('producto_id')),
    cantidad: Number(fd.get('cantidad')),
    tipo: fd.get('tipo'),
  };
  const r = await api('/api/v1/stock', { method: 'POST', body: JSON.stringify(payload) });
  if (r.ok) {
    toast(`stock ${r.body.data.id} ${payload.tipo}`, false);
    loadStock();
    loadProductos();
  } else toast(`stock ${r.status} ${r.text.slice(0, 200)}`);
}

function bind() {
  $('#apiBase').textContent = API_BASE;
  $('#apiInput').value = API_BASE;
  $('#apiSave').onclick = () => {
    const candidate = $('#apiInput').value;
    const normalized = normalizeApiBase(candidate);
    if (!normalized) {
      toast('API_BASE rejected: use an http(s) same-origin or allowlisted URL');
      return;
    }
    localStorage.setItem('api_base', normalized);
    location.href = '?api=' + encodeURIComponent(normalized);
  };
  $('#btnRefresh').onclick = () => {
    renderHealth();
    loadProductos();
    loadOrdenes();
    loadStock();
  };
  $('#ordenTable').addEventListener('click', event => {
    const button = event.target.closest('.bff-btn');
    if (button) bff(Number(button.dataset.ordenId));
  });
  $('#detailsLink').addEventListener('click', event => {
    event.preventDefault();
    api('/api/v1/productos/health/details').then(r => alert(JSON.stringify(r.body, null, 2)));
  });
  $('#prodForm').onsubmit = createProducto;
  $('#ordenForm').onsubmit = createOrden;
  $('#stockForm').onsubmit = createStock;
}

document.addEventListener('DOMContentLoaded', () => {
  bind();
  renderHealth();
  loadProductos();
  loadOrdenes();
  loadStock();
  setInterval(() => {
    renderHealth();
  }, 10000);
});

window.bff = bff;
