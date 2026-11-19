/**
 * SM4-GCM, implemented in plain JavaScript.
 *
 * WHY NOT `node:crypto`: the Harness Host runs on Electron's bundled Node,
 * whose OpenSSL exposes sm4 / sm4-cbc / sm4-cfb / sm4-ctr / sm4-ecb / sm4-ofb
 * but NOT `sm4-gcm` — `createCipheriv('sm4-gcm', ...)` throws "Unknown
 * cipher". A system Node may have it; the Host does not, and this file runs
 * inside the Host process. So the cipher is here, not in the runtime.
 *
 * SCOPE: exactly what the 码道 gateway uses — SM4 block cipher
 * (GB/T 32907-2016, 128-bit key and block, 32 rounds) and GCM
 * (NIST SP 800-38D) with a 12-byte IV and a 16-byte tag. The output is
 * byte-identical to OpenSSL's `sm4-gcm` (cross-checked in the tests).
 *
 * Source of the constants: the published GB/T 32907 S-box and round
 * constants. This is a standard implementation, not a reverse-engineered one.
 */

// ── SM4 block cipher ─────────────────────────────────────────────────────────

const SBOX = new Uint8Array([
  0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
  0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
  0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
  0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
  0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
  0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
  0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
  0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
  0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
  0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
  0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
  0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
  0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
  0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
  0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
  0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
])

const CK = new Uint32Array([
  0x00070e15, 0x1c232a31, 0x383f464d, 0x545b6269,
  0x70777e85, 0x8c939aa1, 0xa8afb6bd, 0xc4cbd2d9,
  0xe0e7eef5, 0xfc030a11, 0x181f262d, 0x343b4249,
  0x50575e65, 0x6c737a81, 0x888f969d, 0xa4abb2b9,
  0xc0c7ced5, 0xdce3eaf1, 0xf8ff060d, 0x141b2229,
  0x30373e45, 0x4c535a61, 0x686f767d, 0x848b9299,
  0xa0a7aeb5, 0xbcc3cad1, 0xd8dfe6ed, 0xf4fb0209,
  0x10171e25, 0x2c333a41, 0x484f565d, 0x646b7279,
])

/** 32-bit left rotation. */
function rotl(x, n) {
  return (x << n) | (x >>> (32 - n))
}

/** The `tau` substitution: byte-wise S-box application. */
function tau(a) {
  return (
    ((SBOX[(a >>> 24) & 0xff] << 24) |
      (SBOX[(a >>> 16) & 0xff] << 16) |
      (SBOX[(a >>> 8) & 0xff] << 8) |
      SBOX[a & 0xff]) >>>
    0
  )
}

/** The `L` transform (encryption/key schedule) and its reverse. */
function L(b) {
  return (b ^ rotl(b, 2) ^ rotl(b, 10) ^ rotl(b, 18) ^ rotl(b, 24)) >>> 0
}
function LPrime(b) {
  return (b ^ rotl(b, 13) ^ rotl(b, 23)) >>> 0
}

/** The linear-transform-round helper shared by encryption and key schedule. */
function t(a) {
  return L(tau(a))
}
function tPrime(a) {
  return LPrime(tau(a))
}

/** The fixed system parameter `FK` of GB/T 32907. */
const FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc]

/**
 * Expand a 16-byte key into 32 round keys.
 *
 * GB/T 32907 key schedule: K[0..3] = MK[0..3] ^ FK[0..3], then
 * rk[i] = K[i+4] = K[i] ^ T'(K[i+1] ^ K[i+2] ^ K[i+3] ^ CK[i]).
 */
function expandKey(key) {
  const K = new Uint32Array(36)
  for (let i = 0; i < 4; i++) {
    K[i] = (((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0) ^ FK[i]
  }
  const rk = new Uint32Array(32)
  for (let i = 0; i < 32; i++) {
    K[i + 4] = (K[i] ^ tPrime((K[i + 1] ^ K[i + 2] ^ K[i + 3] ^ CK[i]) >>> 0)) >>> 0
    rk[i] = K[i + 4]
  }
  return rk
}

/** Encrypt one 16-byte block in place through `out`. */
function encryptBlock(rk, block, out, offset = 0) {
  let x0 = ((block[0] << 24) | (block[1] << 16) | (block[2] << 8) | block[3]) >>> 0
  let x1 = ((block[4] << 24) | (block[5] << 16) | (block[6] << 8) | block[7]) >>> 0
  let x2 = ((block[8] << 24) | (block[9] << 16) | (block[10] << 8) | block[11]) >>> 0
  let x3 = ((block[12] << 24) | (block[13] << 16) | (block[14] << 8) | block[15]) >>> 0

  for (let i = 0; i < 32; i++) {
    const x = (x0 ^ t((x1 ^ x2 ^ x3 ^ rk[i]) >>> 0)) >>> 0
    x0 = x1
    x1 = x2
    x2 = x3
    x3 = x
  }

  // The final round reverses the word order: (x35, x34, x33, x32).
  const words = [x3, x2, x1, x0]
  for (let i = 0; i < 4; i++) {
    const w = words[i]
    out[offset + i * 4] = (w >>> 24) & 0xff
    out[offset + i * 4 + 1] = (w >>> 16) & 0xff
    out[offset + i * 4 + 2] = (w >>> 8) & 0xff
    out[offset + i * 4 + 3] = w & 0xff
  }
}

// ── GHASH ────────────────────────────────────────────────────────────────────

/** Multiply two GF(2^128) elements in the GCM bit order. */
function gfMul(x, y) {
  let z = 0n
  let v = y
  for (let i = 0; i < 128; i++) {
    if ((x >> BigInt(127 - i)) & 1n) z ^= v
    const lsb = v & 1n
    v >>= 1n
    if (lsb) v ^= 0xe1000000000000000000000000000000n
  }
  return z
}

function bytesToBigInt(buf) {
  let n = 0n
  for (const b of buf) n = (n << 8n) | BigInt(b)
  return n
}

function bigIntToBytes(n, len) {
  const out = new Uint8Array(len)
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}

/** Compute GHASH over `aad || ciphertext || lengths`. */
function ghash(hBytes, aad, ciphertext) {
  const h = bytesToBigInt(hBytes)
  let y = 0n
  const push = (data) => {
    for (let i = 0; i < data.length; i += 16) {
      const chunk = new Uint8Array(16)
      chunk.set(data.subarray(i, i + 16))
      y = gfMul(y ^ bytesToBigInt(chunk), h)
    }
  }
  push(aad)
  push(ciphertext)
  const lens = new Uint8Array(16)
  const aadBits = BigInt(aad.length) * 8n
  const ctBits = BigInt(ciphertext.length) * 8n
  lens.set(bigIntToBytes(aadBits, 8), 0)
  lens.set(bigIntToBytes(ctBits, 8), 8)
  y = gfMul(y ^ bytesToBigInt(lens), h)
  return bigIntToBytes(y, 16)
}

/** The GCM initial counter block: J0 = IV || 0^31 || 1 for a 96-bit IV. */
function counterBlock(iv) {
  const j0 = new Uint8Array(16)
  j0.set(iv.subarray(0, 12), 0)
  j0[15] = 1
  return j0
}

/** Increment the low 32 bits of a counter block. */
function inc32(block) {
  for (let i = 15; i >= 12; i--) {
    block[i] = (block[i] + 1) & 0xff
    if (block[i] !== 0) break
  }
}

/** Run CTR mode over `input`, starting from `j0` incremented once. */
function ctrCrypt(rk, j0, input) {
  const out = new Uint8Array(input.length)
  const counter = j0.slice()
  const block = new Uint8Array(16)
  for (let i = 0; i < input.length; i += 16) {
    inc32(counter)
    encryptBlock(rk, counter, block, 0)
    const end = Math.min(16, input.length - i)
    for (let j = 0; j < end; j++) out[i + j] = input[i + j] ^ block[j]
  }
  return out
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Encrypt with SM4-GCM.
 * @param {Uint8Array} key 16-byte key.
 * @param {Uint8Array} iv 12-byte IV.
 * @param {Uint8Array} plaintext data to seal.
 * @param {Uint8Array} aad additional authenticated data.
 * @returns {{ciphertext: Uint8Array, tag: Uint8Array}} ciphertext and the 16-byte tag.
 */
export function sm4GcmEncrypt(key, iv, plaintext, aad = new Uint8Array(0)) {
  if (key.length !== 16) throw new Error('SM4 key must be 16 bytes')
  if (iv.length !== 12) throw new Error('SM4-GCM IV must be 12 bytes')
  const rk = expandKey(key)
  const j0 = counterBlock(iv)
  const ciphertext = ctrCrypt(rk, j0, plaintext)
  const h = new Uint8Array(16)
  encryptBlock(rk, new Uint8Array(16), h, 0)
  const s = ghash(h, aad, ciphertext)
  const ek = new Uint8Array(16)
  encryptBlock(rk, j0, ek, 0)
  const tag = new Uint8Array(16)
  for (let i = 0; i < 16; i++) tag[i] = s[i] ^ ek[i]
  return { ciphertext, tag }
}

/**
 * Decrypt with SM4-GCM and verify the tag.
 * @throws when the tag does not match (tampering or a wrong key/AAD).
 */
export function sm4GcmDecrypt(key, iv, ciphertext, tag, aad = new Uint8Array(0)) {
  if (key.length !== 16) throw new Error('SM4 key must be 16 bytes')
  if (iv.length !== 12) throw new Error('SM4-GCM IV must be 12 bytes')
  if (tag.length !== 16) throw new Error('SM4-GCM tag must be 16 bytes')
  const rk = expandKey(key)
  const j0 = counterBlock(iv)
  const h = new Uint8Array(16)
  encryptBlock(rk, new Uint8Array(16), h, 0)
  const s = ghash(h, aad, ciphertext)
  const ek = new Uint8Array(16)
  encryptBlock(rk, j0, ek, 0)
  const expected = new Uint8Array(16)
  for (let i = 0; i < 16; i++) expected[i] = s[i] ^ ek[i]

  // Constant-time tag comparison: a length-or-content early return would leak
  // how much of the tag matched.
  let diff = 0
  for (let i = 0; i < 16; i++) diff |= expected[i] ^ tag[i]
  if (diff !== 0) throw new Error('SM4-GCM authentication failed')

  return ctrCrypt(rk, j0, ciphertext)
}
