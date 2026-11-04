// Sends an already-resolved request on behalf of the browser (so CORS never
// gets in the way) and returns everything the response viewer needs.
const TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|problem\+json|ld\+json|graphql|.*\+json|.*\+xml))/i;

function buildBody(body, headers) {
  if (!body || body.mode === 'none') return undefined;
  const hasHeader = (name) => headers.some(([k]) => k.toLowerCase() === name);

  if (body.mode === 'raw') {
    if (!hasHeader('content-type')) {
      const types = { json: 'application/json', xml: 'application/xml', html: 'text/html', javascript: 'application/javascript', text: 'text/plain' };
      headers.push(['Content-Type', types[body.rawType] || 'text/plain']);
    }
    return body.raw || '';
  }
  if (body.mode === 'urlencoded') {
    if (!hasHeader('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    const p = new URLSearchParams();
    for (const f of body.urlencoded || []) p.append(f.key, f.value ?? '');
    return p.toString();
  }
  if (body.mode === 'formdata') {
    // fetch sets the multipart boundary itself, so drop any manual content-type.
    for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0].toLowerCase() === 'content-type') headers.splice(i, 1);
    const fd = new FormData();
    for (const f of body.formdata || []) {
      if (f.type === 'file') {
        if (!f.fileData) continue;
        const bytes = Buffer.from(f.fileData, 'base64');
        fd.append(f.key, new Blob([bytes], { type: f.fileType || 'application/octet-stream' }), f.fileName || 'file');
      } else {
        fd.append(f.key, f.value ?? '');
      }
    }
    return fd;
  }
  return undefined;
}

async function send(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const headers = (req.headers || []).filter((h) => h.key).map((h) => [h.key, h.value ?? '']);
  const body = ['GET', 'HEAD'].includes(method) ? undefined : buildBody(req.body, headers);
  const t0 = performance.now();
  const sentHeaders = headers.map(([key, value]) => ({ key, value }));

  try {
    const res = await fetch(req.url, {
      method,
      headers,
      body,
      redirect: req.followRedirects === false ? 'manual' : 'follow',
      signal: AbortSignal.timeout(req.timeoutMs || TIMEOUT_MS),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Math.round(performance.now() - t0);
    const contentType = res.headers.get('content-type') || '';
    const isText = !contentType || TEXT_TYPES.test(contentType);
    const truncated = buf.length > MAX_BODY_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_BODY_BYTES) : buf;
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      ms,
      size: buf.length,
      url: res.url || req.url,
      headers: [...res.headers.entries()].map(([key, value]) => ({ key, value })),
      contentType,
      isText,
      truncated,
      body: isText ? slice.toString('utf8') : slice.toString('base64'),
      request: { method, url: req.url, headers: sentHeaders },
    };
  } catch (err) {
    const cause = err.cause && (err.cause.code || err.cause.message);
    return {
      ok: false,
      status: 0,
      ms: Math.round(performance.now() - t0),
      error:
        err.name === 'TimeoutError'
          ? `Request timed out after ${(req.timeoutMs || TIMEOUT_MS) / 1000}s`
          : explain(cause || err.message, req.url),
      request: { method, url: req.url, headers: sentHeaders },
    };
  }
}

function explain(code, url) {
  if (code === 'ECONNREFUSED') return `Connection refused — nothing is listening at ${url}. Is the server running?`;
  if (code === 'ENOTFOUND') return `Host not found — check the URL (${url}).`;
  if (/Invalid URL|Failed to parse URL/i.test(code)) return `Invalid URL: "${url}". Unresolved {{variables}}?`;
  return code;
}

module.exports = { send };
