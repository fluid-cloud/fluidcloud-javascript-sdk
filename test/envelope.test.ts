import { createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decryptEnvelope,
  encryptEnvelope,
  generateEphemeralKeyPair,
  parsePublicKeyPem,
  type EphemeralKeyPair,
} from '../src/credentials/envelope.js';

import goEnvelope from './fixtures/go-envelope.json';
import keypair from './fixtures/insecure-test-keypair.json';

function keyPairFromFixture(): EphemeralKeyPair {
  const privateKey = createPrivateKey(keypair.privateKeyPem);
  return { privateKey, publicKey: createPublicKey(privateKey), publicKeyPem: keypair.publicKeyPem };
}

describe('envelope', () => {
  it('decrypts an envelope produced by the Go SDK', () => {
    const creds = decryptEnvelope(keyPairFromFixture(), goEnvelope);
    expect(creds).toEqual(goEnvelope.expectedCredentials);
  });

  it('round-trips through its own encrypt', () => {
    const kp = generateEphemeralKeyPair();
    const payload = { accessKey: 'AKIA', secretAccessKey: 'shh', nested: { n: 1 }, list: [1, 2, 3] };
    const sealed = encryptEnvelope(kp.publicKeyPem, payload);
    expect(decryptEnvelope(kp, { provider: 'aws', region: 'us-east-1', ...sealed })).toEqual(payload);
  });

  it('emits a PEM public key the Go SDK parser shape accepts', () => {
    const kp = generateEphemeralKeyPair();
    expect(kp.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(parsePublicKeyPem(kp.publicKeyPem).asymmetricKeyType).toBe('rsa');
  });

  it.each([
    ['tampered ciphertext', (e: typeof goEnvelope) => ({ ...e, encryptedCredentials: flipLastByte(e.encryptedCredentials) })],
    ['tampered nonce', (e: typeof goEnvelope) => ({ ...e, nonce: Buffer.alloc(12).toString('base64') })],
    ['truncated ciphertext', (e: typeof goEnvelope) => ({ ...e, encryptedCredentials: 'AAAA' })],
  ])('rejects %s', (_name, mutate) => {
    expect(() => decryptEnvelope(keyPairFromFixture(), mutate(goEnvelope))).toThrow();
  });

  it('rejects a DEK wrapped for a different key', () => {
    const other = generateEphemeralKeyPair();
    expect(() => decryptEnvelope(other, goEnvelope)).toThrow(/unwrap data encryption key/);
  });

  it('rejects a non-RSA PEM', () => {
    expect(() => parsePublicKeyPem('-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----')).toThrow();
  });
});

function flipLastByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[buf.length - 1] ^= 0xff;
  return buf.toString('base64');
}
