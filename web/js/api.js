// Thin fetch wrapper: returns JSON or throws an Error with the server's message.

async function request(method, url, body, extra = {}) {
  const options = { method, headers: {}, ...extra };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new Error('Server unreachable. Is server.py running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

export const getState = () => request('GET', '/api/state');
/** GET with query parameters; empty values are left out. */
export function get(url, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  return request('GET', query ? `${url}?${query}` : url);
}
export const post = (url, body = {}) => request('POST', url, body);
export const put = (url, body) => request('PUT', url, body);
export const del = (url) => request('DELETE', url);
export const getSettings = () => request('GET', '/api/settings');
/** keepalive lets the request finish while the page is closing. */
export const putSettings = (body, keepalive = false) => request('PUT', '/api/settings', body, { keepalive });
