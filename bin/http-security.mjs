import { networkInterfaces } from 'node:os';

export function isAllowedOrigin(origin, { port = 5173, network = false, addresses = networkInterfaces() } = {}) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) return false;
    if (Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== Number(port)) return false;
    const local = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (network) for (const group of Object.values(addresses)) for (const address of group || []) local.add(address.address.includes(':') ? '[' + address.address + ']' : address.address);
    return local.has(url.hostname);
  } catch { return false; }
}
