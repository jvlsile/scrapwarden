// Contraseñas de un solo uso basadas en tiempo (TOTP, RFC 6238): compatibles con Google Authenticator, Authy, etc.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function code(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1e6).padStart(6, '0');
}

// Acepta el código del intervalo actual y del anterior/siguiente (desfase de reloj de ±30 s).
// Devuelve el contador usado para impedir reutilizar el mismo código.
function verify(secret, token, lastCounter = -1) {
  const t = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const c of [now, now - 1, now + 1]) {
    if (c <= lastCounter) continue;
    const expected = code(secret, c);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(t))) return c;
  }
  return null;
}

const uri = (secret, account, issuer = 'Scrapwarden') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// Códigos de recuperación: 8 grupos tipo "abcd-efgh"; se guardan solo con hash
function recoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const s = crypto.randomBytes(5).toString('hex').slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

module.exports = { newSecret, verify, uri, recoveryCodes, hashCode, _code: code };
