/**
 * Browser-side NIP-19 encoding so the explorer can show npubs and link each
 * release to fanfares.io/naddr/... without any dependency.
 */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** Regroups 8-bit bytes into 5-bit words for bech32. */
function toWords(bytes) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

/** bech32-encodes `bytes` under `hrp` (no length limit, as NIP-19 TLVs need). */
function bech32(hrp, bytes) {
  const words = toWords(bytes);
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...checksum].map((w) => CHARSET[w]).join('');
}

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** npub for a hex pubkey. */
export function npub(hex) {
  return /^[0-9a-f]{64}$/.test(hex || '') ? bech32('npub', hexToBytes(hex)) : '';
}

/** Short npub for display: npub1abcd…wxyz. */
export function shortNpub(hex) {
  const n = npub(hex);
  return n ? `${n.slice(0, 10)}…${n.slice(-4)}` : '';
}

/**
 * naddr for a `kind:pubkey:d` address, with the Fanfares relay as hint.
 * @param {string} address Release address from the API.
 */
export function naddr(address, relay = 'wss://fanfares.nostr1.com') {
  const [kindStr, pubkey, ...rest] = String(address).split(':');
  const d = rest.join(':');
  const kind = Number(kindStr);
  if (!d || !/^[0-9a-f]{64}$/.test(pubkey)) return '';
  const enc = new TextEncoder();
  const tlv = (type, bytes) => [type, bytes.length, ...bytes];
  const kindBytes = [(kind >>> 24) & 255, (kind >>> 16) & 255, (kind >>> 8) & 255, kind & 255];
  return bech32('naddr', [
    ...tlv(0, [...enc.encode(d)]),
    ...tlv(1, [...enc.encode(relay)]),
    ...tlv(2, hexToBytes(pubkey)),
    ...tlv(3, kindBytes)
  ]);
}

/** Link to a release on fanfares.io, or '' when it has no address. */
export function fanfaresUrl(address) {
  const n = naddr(address);
  return n ? `https://fanfares.io/naddr/${n}` : '';
}

/** Link to a profile on fanfares.io. */
export function fanfaresProfileUrl(hex) {
  const n = npub(hex);
  return n ? `https://fanfares.io/p/${n}` : '';
}
