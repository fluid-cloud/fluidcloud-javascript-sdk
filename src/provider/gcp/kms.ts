import { KeyManagementServiceClient, type protos } from '@google-cloud/kms';

import type { GcpCredentials } from '../../credentials/index.js';
import { ProviderError, wrapProviderError } from '../../errors.js';
import {
  canonicalContext,
  crc32c,
  randomKeyBytes,
  supportsKmsOperation,
  validateDataKeySize,
  validateKmsInput,
} from '../shared/kms.js';
import type { DataKey, Kms, KmsEncryptResult, KmsOperation, KmsOptions } from '../types/kms.js';
import { gcpClientConfig } from './auth.js';

const CRYPTO_KEY_VERSION_SEGMENT = '/cryptoKeyVersions/';

type Int64 = { value?: number | string | { toString(): string } | null } | null | undefined;

function int64(v: Int64): number {
  return v?.value === undefined || v.value === null ? Number.NaN : Number(v.value.toString());
}

function bytes(v?: Uint8Array | Buffer | string | null): Buffer {
  if (!v) return Buffer.alloc(0);
  return typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.from(v);
}

/** Decrypt only accepts the CryptoKey and picks the version from the ciphertext. */
function cryptoKeyName(keyId: string): string {
  const i = keyId.indexOf(CRYPTO_KEY_VERSION_SEGMENT);
  return i >= 0 ? keyId.slice(0, i) : keyId;
}

function checksumError(op: string): ProviderError {
  return new ProviderError('gcp', op, new Error('crc32c integrity check failed in transit'));
}

/**
 * Cloud KMS implementation of the unified Kms interface, for ENCRYPT_DECRYPT
 * keys. The encryption context is sent as additionalAuthenticatedData,
 * canonically encoded, and every request and response is CRC32C-verified as
 * Google recommends.
 */
export class CloudKms implements Kms {
  private readonly client: KeyManagementServiceClient;

  constructor(creds: GcpCredentials) {
    const cfg = gcpClientConfig(creds);
    this.client = new KeyManagementServiceClient({ projectId: cfg.projectId, credentials: cfg.credentials });
  }

  async encrypt(keyId: string, plaintext: Buffer | Uint8Array, opts?: KmsOptions): Promise<KmsEncryptResult> {
    validateKmsInput(keyId, plaintext);
    const aad = canonicalContext(opts);
    let resp: protos.google.cloud.kms.v1.IEncryptResponse;
    try {
      [resp] = await this.client.encrypt({
        name: keyId,
        plaintext,
        plaintextCrc32c: { value: crc32c(plaintext) },
        ...(aad.length > 0
          ? { additionalAuthenticatedData: aad, additionalAuthenticatedDataCrc32c: { value: crc32c(aad) } }
          : {}),
      });
    } catch (err) {
      wrapProviderError('gcp', 'Encrypt', err);
    }
    const ciphertext = bytes(resp.ciphertext);
    if (
      !resp.verifiedPlaintextCrc32c ||
      (aad.length > 0 && !resp.verifiedAdditionalAuthenticatedDataCrc32c) ||
      int64(resp.ciphertextCrc32c) !== crc32c(ciphertext)
    ) {
      throw checksumError('Encrypt');
    }
    return { ciphertext, keyId: resp.name ?? '' };
  }

  async decrypt(keyId: string, ciphertext: Buffer | Uint8Array, opts?: KmsOptions): Promise<Buffer> {
    validateKmsInput(keyId, ciphertext);
    const aad = canonicalContext(opts);
    let resp: protos.google.cloud.kms.v1.IDecryptResponse;
    try {
      [resp] = await this.client.decrypt({
        name: cryptoKeyName(keyId),
        ciphertext,
        ciphertextCrc32c: { value: crc32c(ciphertext) },
        ...(aad.length > 0
          ? { additionalAuthenticatedData: aad, additionalAuthenticatedDataCrc32c: { value: crc32c(aad) } }
          : {}),
      });
    } catch (err) {
      wrapProviderError('gcp', 'Decrypt', err);
    }
    const plaintext = bytes(resp.plaintext);
    if (int64(resp.plaintextCrc32c) !== crc32c(plaintext)) throw checksumError('Decrypt');
    return plaintext;
  }

  /** Generates the key locally, as Cloud KMS documents for envelope encryption. */
  async generateDataKey(keyId: string, numBytes: number, opts?: KmsOptions): Promise<DataKey> {
    validateDataKeySize(numBytes);
    const plaintext = randomKeyBytes(numBytes);
    const res = await this.encrypt(keyId, plaintext, opts);
    return { plaintext, ciphertext: res.ciphertext, keyId: res.keyId };
  }

  supports(op: KmsOperation): boolean {
    return supportsKmsOperation(op);
  }

  provider(): string {
    return 'gcp';
  }

  /** Releases the underlying gRPC channel. */
  async close(): Promise<void> {
    await this.client.close();
  }
}
