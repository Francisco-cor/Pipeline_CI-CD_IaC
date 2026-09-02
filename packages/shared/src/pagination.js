'use strict';

// SPDX-License-Identifier: MIT
// Shared pagination — Fase 3.7
// Parse ?page&limit&sort, cap limit 100, return offset/limit + headers.

/**
 * @param {import('express').Request} req
 * @returns {{page:number, limit:number, offset:number, sort:string}}
 */
function parsePagination(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const sortParam = req.query.sort;
  const allowed = ['created_at_asc', 'created_at_desc'];
  const sort = allowed.includes(sortParam) ? sortParam : 'created_at_desc';
  const offset = (page - 1) * limit;
  return { page, limit, offset, sort };
}

/**
 * Totales y Link header RFC5988
 */
function setPaginationHeaders(res, req, page, limit, total) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  res.set('X-Total-Count', String(total));
  res.set('X-Page', String(page));
  res.set('X-Limit', String(limit));
  res.set('X-Total-Pages', String(totalPages));

  const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}${req.path}`;
  // req.baseUrl es mount point (e.g. /productos), req.path es '/' — usamos originalUrl sin query
  const urlBase = baseUrl.replace(/\/$/, '');
  const links = [];
  const makeUrl = p => `${urlBase}?page=${p}&limit=${limit}`;
  links.push(`<${makeUrl(page)}>; rel="self"`);
  if (page > 1) links.push(`<${makeUrl(1)}>; rel="first"`);
  if (page > 1) links.push(`<${makeUrl(page - 1)}>; rel="prev"`);
  if (page < totalPages) links.push(`<${makeUrl(page + 1)}>; rel="next"`);
  if (totalPages > 1) links.push(`<${makeUrl(totalPages)}>; rel="last"`);
  res.set('Link', links.join(', '));
}

function sortToOrderBy(sort) {
  return sort === 'created_at_asc' ? 'created_at ASC' : 'created_at DESC';
}

module.exports = { parsePagination, setPaginationHeaders, sortToOrderBy };
