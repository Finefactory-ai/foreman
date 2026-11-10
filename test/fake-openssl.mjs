// Key pairs and a fake openssl for the Salesforce key tests. No PEM fixture lives in the repo:
// makePair builds a real self-signed X.509 certificate in DER with node:crypto.
//
//   makePair({ cn, notBefore, notAfter, keyType })
//                                { keyPem, certPem, key }: a new key (pkcs8 PEM) and a
//                                certificate for it, signed by it, valid from notBefore to
//                                notAfter (Dates; 2025-01-01 to 2030-01-01 by default). keyType
//                                'ec' makes a P-256 key, which Salesforce's JWT sign-in cannot use.
//   fakeOpenssl({ pair, status }) an sh(cmd, args, opts) that plays `openssl req -x509 ...`: it
//                                writes pair.keyPem after -keyout and pair.certPem after -out and
//                                exits 0, or, with a non-zero status, writes only the key (as a
//                                failing openssl can leave one) and exits with it. Any other
//                                command exits 0. sh.calls records { cmd, args, opts }; use it as
//                                fakeSfShell's fallback.

import crypto from 'node:crypto';
import fs from 'node:fs';

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const oid = (hex) => tlv(0x06, Buffer.from(hex, 'hex'));
const NULL = Buffer.from([0x05, 0x00]);
const integer = (n) => tlv(0x02, Buffer.from([n]));

// YYMMDDHHMMSSZ, which covers 1950 to 2049.
function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const text = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

const name = (cn) => seq(tlv(0x31, seq(oid('550403'), tlv(0x0c, Buffer.from(cn, 'utf8')))));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

export function makePair({ cn = 'Acme', notBefore = new Date('2025-01-01T00:00:00Z'), notAfter = new Date('2030-01-01T00:00:00Z'), keyType = 'rsa' } = {}) {
  const { privateKey, publicKey } =
    keyType === 'ec' ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = seq(oid('2a864886f70d01010b'), NULL); // sha256WithRSAEncryption
  const tbs = seq(
    tlv(0xa0, integer(2)),
    integer(1),
    alg,
    name(cn),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, alg, tlv(0x03, Buffer.from([0]), signature));
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), certPem: pem('CERTIFICATE', cert), key: privateKey };
}

const after = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

export function fakeOpenssl({ pair, status = 0 } = {}) {
  const calls = [];
  const sh = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args: [...args], opts });
    if (cmd !== 'openssl') return { status: 0, stdout: '', stderr: '' };
    const keyOut = after(args, '-keyout');
    const certOut = after(args, '-out');
    if (keyOut) fs.writeFileSync(keyOut, pair.keyPem);
    if (status !== 0) return { status, stdout: '', stderr: 'acme openssl: could not write the certificate' };
    if (certOut) fs.writeFileSync(certOut, pair.certPem);
    return { status: 0, stdout: '', stderr: '..+++++\n-----\n' };
  };
  sh.calls = calls;
  return sh;
}
