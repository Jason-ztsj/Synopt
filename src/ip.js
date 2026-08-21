import net from 'node:net';

export function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (candidate.includes(',') || net.isIP(candidate) === 0) return null;
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const ipv4 = candidate.slice(7);
    if (net.isIP(ipv4) === 4) return ipv4;
  }
  return candidate;
}

export function getClientIp(request, mode = 'direct') {
  const direct = normalizeIp(request?.socket?.remoteAddress) ?? 'unknown';
  if (mode !== 'cloudflare') return direct;
  const header = request?.headers?.['cf-connecting-ip'];
  if (Array.isArray(header)) return direct;
  return normalizeIp(header) ?? direct;
}

