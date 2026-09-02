// SPDX-License-Identifier: MIT
// Frontend dashboard — vanilla JS, fetch NGINX API (http://localhost:80 default)
const API_BASE = (() => {
  const qs = new URLSearchParams(location.search);
  return qs.get('api') || localStorage.getItem('api_base') || 'http://localhost:80';
})();

const $ = s => document.querySelector(s);
const toast = (msg, isErr = true) => {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? '' : '');
  setTimeout(() => (t.className = 'toast'), 4000);
};

async function api(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
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
    $('#health').innerHTML = `
      <div class="kv">
        <b>nginx</b><span class="${ng.ok ? 'ok' : 'err'}">${ng.status} ${ng.ok ? 'ok' : 'fail'}</span>
        <b>productos</b><span class="${p.ok ? 'ok' : 'err'}">${p.status} ${p.body?.status || ''}</span>
        <b>ordenes</b><span class="${o.ok ? 'ok' : 'err'}">${o.status} ${o.body?.status || ''}</span>
        <b>stock</b><span class="${s.ok ? 'ok' : 'err'}">${s.status} ${s.body?.status || ''}</span>
        <b>details pool</b><span class="muted">${d.body?.pool ? JSON.stringify(d.body.pool) : '—'} uptime ${d.body?.uptime_s || '—'}s</span>
      </div>
      <div class="muted" style="margin-top:8px">X-Request-Id: ${ng.headers['x-request-id'] || '—'} • <a href="${API_BASE}/metrics" target="_blank">/metrics</a> • <a href="${API_BASE}/api/v1/productos?limit=1" target="_blank">api sample</a></div>
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
    <tr><td>${p.id}</td><td>${p.nombre}</td><td>${p.precio}</td><td>${p.stock}</td></tr>
  `
        )
        .join('') || '<tr><td colspan=4 class="muted">vacío</td></tr>';
  // fill select for orden/stock
  const sel = $('#ordenProdId');
  if (sel)
    sel.innerHTML = rows
      .map(
        p =>
          `<option value="${p.id}">${p.id} — ${p.nombre.slice(0, 18)} (stock ${p.stock})</option>`
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
    <tr><td>${o.id}</td><td>${o.producto_id}</td><td>${o.cantidad}</td><td>${o.total}</td><td><button onclick="bff(${o.id})">include</button></td></tr>
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
    <tr><td>${s.id}</td><td>${s.producto_id}</td><td>${s.cantidad}</td><td>${s.tipo}</td></tr>
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
    localStorage.setItem('api_base', $('#apiInput').value);
    location.href = '?api=' + encodeURIComponent($('#apiInput').value);
  };
  $('#btnRefresh').onclick = () => {
    renderHealth();
    loadProductos();
    loadOrdenes();
    loadStock();
  };
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
