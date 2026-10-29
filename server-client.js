'use strict';

// Akun di server Lensa (butir 4): masuk, daftar, login SIPARAKAI, profil + kuota, keluar.

const AUTH_PATHS = {
  login: '/v1/auth/login',
  register: '/v1/auth/register',
  siparakai: '/v1/auth/siparakai',
};

function normalizeServerUrl(url) {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Alamat server tidak valid. Contoh: https://lensa.sekolahku.id');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Alamat server harus diawali http:// atau https://');
  return trimmed;
}

async function request(serverUrl, path, { method = 'GET', token, body } = {}) {
  let res;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`Server Lensa tidak dapat dihubungi: ${err.message}`);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    // Ditangani di bawah.
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Server Lensa membalas HTTP ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** method: 'login' | 'register' | 'siparakai'. Mengembalikan { token, user, quota }. */
function authenticate(serverUrl, method, fields) {
  const path = AUTH_PATHS[method];
  if (!path) throw new Error(`Metode masuk tidak dikenal: ${method}`);
  return request(serverUrl, path, { method: 'POST', body: fields });
}

const profile = (serverUrl, token) => request(serverUrl, '/v1/me', { token });

const logout = (serverUrl, token) =>
  request(serverUrl, '/v1/auth/logout', { method: 'POST', token, body: {} }).catch(() => null);

module.exports = { normalizeServerUrl, authenticate, profile, logout };
