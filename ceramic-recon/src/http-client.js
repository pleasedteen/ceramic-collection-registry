'use strict';

function client(baseUrl) {
  return {
    baseUrl,
    async call(method, path, body) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const err = /** @type {Error & { status: number, body: unknown }} */ (
          new Error(`HTTP ${res.status} ${method} ${path}: ${json.error || text}`)
        );
        err.status = res.status;
        err.body = json;
        throw err;
      }
      return json;
    },
    get(p) {
      return this.call('GET', p);
    },
    post(p, b) {
      return this.call('POST', p, b);
    },
  };
}

module.exports = { client };
