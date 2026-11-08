// Tokyo-side front for the Mac reranker (deploy/mac-rerank/server.py).
//
// Core only accepts HTTP on localhost, and Hindsight retries timeouts and 5xx up to three times, so a sleeping
// Mac would stall every recall. This proxy probes the Mac every few seconds; while it is unreachable every request
// fails at once with 424 (no client retries a 4xx), so Core falls back to rank fusion and Hindsight to its next
// reranker member (rrf) immediately.
//
//   RERANK_UPSTREAM  http://10.73.236.92:8081         the Mac over ZeroTier
//   RERANK_LISTEN    127.0.0.1:18081,172.18.0.1:18081  loopback for Core, the hindsight_default bridge for Hindsight
import http from 'node:http';

const upstream = new URL(process.env.RERANK_UPSTREAM || 'http://10.73.236.92:8081');
const listen = (process.env.RERANK_LISTEN || '127.0.0.1:18081').split(',').map((item) => item.trim()).filter(Boolean);
const PROBE_MS = 5000, PROBE_TIMEOUT_MS = 3000, REQUEST_TIMEOUT_MS = Number(process.env.RERANK_TIMEOUT_MS || 25000);
const MAX_BODY = 16 * 1024 * 1024;
const ROUTES = new Set(['GET /health', 'GET /info', 'POST /rerank', 'POST /v1/rerank']);
const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });

let up = false, since = Date.now(), lastError = 'not probed yet';
const mark = (next, error = '') => {
  if (next !== up) { console.log(`${new Date().toISOString()} upstream ${next ? 'up' : `down: ${error}`}`); up = next; since = Date.now(); }
  if (!next) lastError = error;
};

function probe() {
  const request = http.get(new URL('/health', upstream), { agent, timeout: PROBE_TIMEOUT_MS }, (response) => {
    response.resume();
    response.on('end', () => mark(response.statusCode === 200, `health ${response.statusCode}`));
  });
  request.on('timeout', () => request.destroy(new Error('probe timeout')));
  request.on('error', (error) => mark(false, error.message));
}
probe();
setInterval(probe, PROBE_MS).unref();

const reply = (response, status, body) => {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
};

function handle(request, response) {
  const path = new URL(request.url, 'http://local').pathname;
  if (path === '/proxy/health') return reply(response, 200, { upstream: upstream.origin, up, since: new Date(since).toISOString(), ...(up ? {} : { error: lastError }) });
  if (!ROUTES.has(`${request.method} ${path}`)) return reply(response, 404, { error: 'not found' });
  if (!up) { request.resume(); return reply(response, 424, { error: 'reranker offline', error_type: 'Unavailable', detail: lastError }); }
  if (Number(request.headers['content-length'] || 0) > MAX_BODY) { request.resume(); return reply(response, 413, { error: 'request too large' }); }
  const forward = http.request(new URL(path, upstream), {
    method: request.method, agent, timeout: REQUEST_TIMEOUT_MS,
    headers: { 'content-type': request.headers['content-type'] || 'application/json', ...(request.headers['content-length'] ? { 'content-length': request.headers['content-length'] } : {}) },
  }, (answer) => {
    // A full queue on the Mac (429) is answered as 424 too: a retry would only queue again, so fall back now.
    if (answer.statusCode === 429) { answer.resume(); return reply(response, 424, { error: 'reranker busy', error_type: 'Overloaded' }); }
    response.writeHead(answer.statusCode ?? 502, { 'Content-Type': answer.headers['content-type'] || 'application/json' });
    answer.pipe(response);
  });
  // A slow answer means the Mac is busy, not gone: fail this request only and leave the probe to decide.
  let timedOut = false;
  forward.on('timeout', () => { timedOut = true; forward.destroy(new Error('upstream timeout')); });
  forward.on('error', (error) => {
    if (!timedOut && !response.headersSent) mark(false, error.message);
    reply(response, 424, { error: timedOut ? 'reranker busy' : 'reranker unreachable', error_type: timedOut ? 'Overloaded' : 'Unavailable', detail: error.message });
  });
  request.pipe(forward);
}

for (const address of listen) {
  const [host, port] = [address.slice(0, address.lastIndexOf(':')), Number(address.slice(address.lastIndexOf(':') + 1))];
  http.createServer(handle).on('error', (error) => { console.error(`listen ${address}: ${error.message}`); process.exit(1); }).listen(port, host, () => console.log(`listening on ${address} -> ${upstream.origin}`));
}
