import { randomBytes as cryptoRandomBytes } from 'node:crypto';

import { ValidationError } from '../../errors.js';
import type { KmsOperation, KmsOptions } from '../types/kms.js';

/** Matches the AWS GenerateDataKey NumberOfBytes upper bound. */
export const MAX_DATA_KEY_BYTES = 1024;

/** Returns the encryption context, or undefined when it is empty. */
export function kmsContext(opts?: KmsOptions): Record<string, string> | undefined {
  const ctx = opts?.encryptionContext;
  return ctx && Object.keys(ctx).length > 0 ? ctx : undefined;
}

/**
 * Encodes a context deterministically: keys sorted by UTF-8 bytes, each key and
 * value prefixed with its big-endian uint32 byte length. Identical to the Go and
 * Python SDKs. An empty context encodes to an empty buffer.
 */
export function canonicalContext(opts?: KmsOptions): Buffer {
  const ctx = kmsContext(opts);
  if (!ctx) return Buffer.alloc(0);
  const entries = Object.entries(ctx).map(([k, v]) => [Buffer.from(k, 'utf8'), Buffer.from(v, 'utf8')] as const);
  entries.sort(([a], [b]) => Buffer.compare(a, b));
  const parts: Buffer[] = [];
  for (const [k, v] of entries) {
    const kl = Buffer.alloc(4);
    kl.writeUInt32BE(k.length);
    const vl = Buffer.alloc(4);
    vl.writeUInt32BE(v.length);
    parts.push(kl, k, vl, v);
  }
  return Buffer.concat(parts);
}

export function validateKmsInput(keyId: string, data?: Buffer | Uint8Array): void {
  if (!keyId) throw new ValidationError('keyId', 'is required');
  if (data !== undefined && data.length === 0) throw new ValidationError('input', 'must not be empty');
}

export function validateDataKeySize(numBytes: number): void {
  if (!Number.isInteger(numBytes) || numBytes < 1 || numBytes > MAX_DATA_KEY_BYTES) {
    throw new ValidationError('numBytes', `must be between 1 and ${MAX_DATA_KEY_BYTES}, got ${numBytes}`);
  }
}

export function randomKeyBytes(n: number): Buffer {
  return cryptoRandomBytes(n);
}

export function supportsKmsOperation(op: KmsOperation): boolean {
  return op === 'encrypt' || op === 'decrypt' || op === 'generate_data_key';
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC32C (Castagnoli), the checksum Cloud KMS uses for integrity checks. */
export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC32C_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
