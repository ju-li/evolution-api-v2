import axios from 'axios';
import { lookup as dnsLookup } from 'dns';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { BlockList, isIP, LookupFunction } from 'net';

/**
 * Fetches media from a tenant-supplied URL without letting the tenant reach the
 * server's own network (SSRF): only http/https, every resolved address must be
 * public, the connection is pinned to the addresses that were validated (no DNS
 * rebinding), redirects are followed manually and re-validated, and size/time
 * are capped.
 */

export class UnsafeMediaUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeMediaUrlError';
  }
}

const blockList = new BlockList();
// IPv4: "this network", RFC1918, CGNAT, loopback, link-local, IETF protocol assignments,
// documentation/benchmarking ranges, multicast, reserved and broadcast.
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockList.addSubnet(net, prefix, 'ipv4');
}
// IPv6: unspecified, loopback, IPv4-compatible, discard, local-use NAT64, documentation,
// unique-local, link-local, site-local (deprecated) and multicast.
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['100::', 64],
  ['64:ff9b:1::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockList.addSubnet(net, prefix, 'ipv6');
}

/** Returns the embedded IPv4 address of an IPv4-mapped IPv6 address (::ffff:a.b.c.d / ::ffff:xxxx:xxxx). */
function mappedIPv4(address: string): string | null {
  const match = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(.+)$/i.exec(address);
  if (!match) return null;
  const tail = match[1];
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockList.check(address, 'ipv4');
  if (family === 6) {
    const v4 = mappedIPv4(address);
    if (v4) return blockList.check(v4, 'ipv4');
    return blockList.check(address, 'ipv6');
  }
  return true;
}

function assertPublic(addresses: string[], hostname: string) {
  if (!addresses.length) {
    throw new UnsafeMediaUrlError(`Could not resolve media host ${hostname}`);
  }
  if (addresses.some(isBlockedAddress)) {
    throw new UnsafeMediaUrlError(`Media URL host ${hostname} resolves to a non-public address`);
  }
}

function resolveAll(hostname: string): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
}

/**
 * Lookup used by the agents for every connection (including after redirects): resolves, rejects
 * the whole host if any address is non-public, and hands the validated addresses to the socket,
 * so the connection uses exactly what was checked.
 */
const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  resolveAll(hostname)
    .then((addresses) => {
      assertPublic(
        addresses.map((a) => a.address),
        hostname,
      );
      const wanted = options?.family ? addresses.filter((a) => a.family === options.family) : addresses;
      if (!wanted.length) throw new UnsafeMediaUrlError(`Could not resolve media host ${hostname}`);
      if (options?.all) {
        (callback as any)(null, wanted);
      } else {
        callback(null, wanted[0].address, wanted[0].family);
      }
    })
    .catch((err) => callback(err, undefined, undefined));
};

const httpAgent = new HttpAgent({ lookup: pinnedLookup });
const httpsAgent = new HttpsAgent({ lookup: pinnedLookup });

/** Parses and validates a URL before any connection: scheme, and literal or resolved host addresses. */
export async function assertSafeMediaUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeMediaUrlError('Invalid media URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeMediaUrlError('Media URL must use http or https');
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!hostname) {
    throw new UnsafeMediaUrlError('Invalid media URL');
  }

  if (isIP(hostname)) {
    assertPublic([hostname], hostname);
  } else {
    let addresses: { address: string }[];
    try {
      addresses = await resolveAll(hostname);
    } catch {
      throw new UnsafeMediaUrlError(`Could not resolve media host ${hostname}`);
    }
    assertPublic(
      addresses.map((a) => a.address),
      hostname,
    );
  }

  return url;
}

export type SafeFetchMediaOptions = {
  /** Agent for https requests (e.g. the instance proxy). The proxy resolves the host, so only the pre-check applies. */
  proxyAgent?: any;
  timeoutMs?: number;
  maxContentLength?: number;
  maxRedirects?: number;
};

export type SafeFetchMediaResult = {
  buffer: Buffer;
  contentType?: string;
};

export const SAFE_FETCH_MEDIA_DEFAULTS = {
  timeoutMs: 60_000,
  maxContentLength: 100 * 1024 * 1024,
  maxRedirects: 5,
};

export async function safeFetchMedia(
  rawUrl: string,
  options: SafeFetchMediaOptions = {},
): Promise<SafeFetchMediaResult> {
  const timeoutMs = options.timeoutMs ?? SAFE_FETCH_MEDIA_DEFAULTS.timeoutMs;
  const maxContentLength = options.maxContentLength ?? SAFE_FETCH_MEDIA_DEFAULTS.maxContentLength;
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_MEDIA_DEFAULTS.maxRedirects;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertSafeMediaUrl(current);

    const response = await axios.get(url.toString(), {
      responseType: 'arraybuffer',
      maxRedirects: 0,
      proxy: false,
      timeout: timeoutMs,
      maxContentLength,
      httpAgent,
      httpsAgent: options.proxyAgent ?? httpsAgent,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    if (response.status >= 300) {
      const location = response.headers['location'];
      if (!location) {
        throw new UnsafeMediaUrlError(`Media URL redirected without a location (HTTP ${response.status})`);
      }
      current = new URL(location, url).toString();
      continue;
    }

    const contentType = response.headers['content-type'];
    return {
      buffer: Buffer.from(response.data),
      contentType: typeof contentType === 'string' ? contentType : undefined,
    };
  }

  throw new UnsafeMediaUrlError('Too many redirects while fetching media URL');
}
