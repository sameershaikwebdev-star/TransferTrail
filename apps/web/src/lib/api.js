const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export async function apiRequest(path, { method = 'GET', body, token, signal, onUnauthorized, headers: extraHeaders } = {}) {
  const headers = new Headers({ Accept: 'application/json' });
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Unable to reach BalanceVault. Check your connection and try again.', 0);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Keep a safe generic message when a proxy returns a non-JSON error page.
  }

  if (response.status === 401 && token) onUnauthorized?.();
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : 'The request could not be completed.';
    throw new ApiError(message, response.status, payload);
  }
  return payload;
}

export async function getBackendStatus(signal) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/ready`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    return response.ok;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return false;
  }
}
