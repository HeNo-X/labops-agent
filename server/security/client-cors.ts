import type {IncomingMessage, ServerResponse} from 'node:http';
// Local installed clients use these virtual origins. No remote page is loaded.
const DEFAULT_ORIGINS = ['https://qzapp.localhost', 'https://tauri.localhost', 'https://localhost'];
const METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const HEADERS = ['authorization', 'content-type', 'x-request-id', 'x-lab-token', 'accept'];
export const CLIENT_API_REVISION = '20261010-cloud-api.1';
function vary(res: ServerResponse, values: string[]) {
    const existing = String(res.getHeader('Vary') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (existing.includes('*')) return;
    for (const value of values) if (!existing.some(s => s.toLowerCase() === value.toLowerCase())) existing.push(value);
    res.setHeader('Vary', existing.join(', '));
}
export function allowedClientOrigins() {
    return (process.env.CLIENT_ALLOWED_ORIGINS === undefined ? DEFAULT_ORIGINS : process.env.CLIENT_ALLOWED_ORIGINS.split(',')).map(s => s.trim()).filter(Boolean);
}
export function clientCors(req: IncomingMessage, res: ServerResponse) {
    if (!(req.url || '').startsWith('/api/')) return false;
    const origin = req.headers.origin;
    vary(res, ['Origin']);
    if (req.method === 'OPTIONS') vary(res, ['Access-Control-Request-Method', 'Access-Control-Request-Headers']);
    if (!origin || !allowedClientOrigins().includes(origin)) {
        if (origin && req.method === 'OPTIONS') {
            res.writeHead(403, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
            res.end(JSON.stringify({error:'client_origin_rejected'}));
            return true;
        }
        return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, Retry-After, Content-Disposition');
    if (req.method !== 'OPTIONS') return false;
    const method = String(req.headers['access-control-request-method'] || '').toUpperCase();
    const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (!METHODS.split(', ').includes(method) || requested.some(h => !HEADERS.includes(h))) {
        res.writeHead(403, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'client_preflight_rejected'}));
        return true;
    }
    res.setHeader('Access-Control-Allow-Methods', METHODS);
    res.setHeader('Access-Control-Allow-Headers', HEADERS.join(', '));
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204); res.end(); return true;
}

