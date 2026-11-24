import assert from 'node:assert/strict';
import { test } from 'vitest';
import { sm4GcmEncrypt, sm4GcmDecrypt } from '../src/protocol/sm4.ts';
import { createCipheriv } from 'node:crypto';

const hex = (u8) => Buffer.from(u8).toString('hex');

test('SM4-GCM encryption and authentication', async () => {

// 1) round-trip over a UTF-8 payload longer than one block
{
  const key = Buffer.from('0123456789abcdeffedcba9876543210', 'hex');
  const iv = Buffer.alloc(12, 7);
  const pt = Buffer.from('hello 码道 SM4-GCM — a payload longer than sixteen bytes', 'utf8');
  const aad = Buffer.from('aad-header');
  const { ciphertext, tag } = sm4GcmEncrypt(key, iv, pt, aad);
  const back = Buffer.from(sm4GcmDecrypt(key, iv, ciphertext, tag, aad));
  assert.equal(back.toString('utf8'), pt.toString('utf8'));
  console.log('✓ round-trip');
}

// 2) byte-identical to OpenSSL's native sm4-gcm (skipped when absent)
{
  const key = Buffer.from('0123456789abcdeffedcba9876543210', 'hex');
  const iv = Buffer.alloc(12, 7);
  const pt = Buffer.from('cross-check against native', 'utf8');
  const aad = Buffer.from('aad');
  const mine = sm4GcmEncrypt(key, iv, pt, aad);
  try {
    const c = createCipheriv('sm4-gcm', key, iv) as ReturnType<typeof createCipheriv> & {
      setAAD(buffer: Uint8Array): void;
      getAuthTag(): Buffer;
    };
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    assert.equal(hex(ct), hex(mine.ciphertext), 'ciphertext');
    assert.equal(hex(c.getAuthTag()), hex(mine.tag), 'tag');
    console.log('✓ byte-identical to native sm4-gcm');
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (('code' in error && error.code === 'ERR_CRYPTO_UNKNOWN_CIPHER') || /Unknown cipher/.test(error.message)) {
      console.log('- native sm4-gcm unavailable, cross-check skipped');
    } else throw e;
  }
}

// 3) tampering and a wrong AAD both fail authentication
{
  const key = Buffer.alloc(16, 3);
  const iv = Buffer.alloc(12, 9);
  const pt = Buffer.from('payload');
  const { ciphertext, tag } = sm4GcmEncrypt(key, iv, pt, Buffer.from('aad'));
  assert.throws(() => sm4GcmDecrypt(key, iv, ciphertext, Buffer.alloc(16), Buffer.from('aad')), /authentication failed/);
  assert.throws(() => sm4GcmDecrypt(key, iv, ciphertext, tag, Buffer.from('other')), /authentication failed/);
  const bad = Uint8Array.from(ciphertext); bad[0] ^= 1;
  assert.throws(() => sm4GcmDecrypt(key, iv, bad, tag, Buffer.from('aad')), /authentication failed/);
  console.log('✓ tamper and wrong-AAD rejected');
}

// 4) the exact AAD shape 码道 uses on SSE chunks: `${keyId}|${chunkIndex}`
{
  const key = Buffer.alloc(16, 1);
  const iv = Buffer.alloc(12, 2);
  const aad = Buffer.from('abc123|7');
  const pt = Buffer.from('{"type":"text-delta"}');
  const { ciphertext, tag } = sm4GcmEncrypt(key, iv, pt, aad);
  const back = Buffer.from(sm4GcmDecrypt(key, iv, ciphertext, tag, aad));
  assert.equal(back.toString(), pt.toString());
  console.log('✓ 码道 AAD shape');
}
})
