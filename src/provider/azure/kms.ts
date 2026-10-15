import { createHash, timingSafeEqual } from 'node:crypto';

import { CryptographyClient, KeyClient } from '@azure/keyvault-keys';

import type { AzureCredentials } from '../../credentials/index.js';
import { InvalidCredentialsError, ProviderError, ValidationError, wrapProviderError } from '../../errors.js';
import {
  canonicalContext,
  randomKeyBytes,
  supportsKmsOperation,
  validateDataKeySize,
  validateKmsInput,
} from '../shared/kms.js';
import type { DataKey, Kms, KmsEncryptResult, KmsOperation, KmsOptions } from '../types/kms.js';
import { azureCredential } from './auth.js';

const RSA_OAEP_256 = 'RSA-OAEP-256';
const CONTEXT_DIGEST_SIZE = 32;

/** Accepts a Key Vault name or a full vault URL (required for Managed HSM). */
export function vaultBaseUrl(vault: string): string {
  if (vault.startsWith('https://')) return `${vault.replace(/\/+$/, '')}/`;
  return `https://${vault}.vault.azure.net/`;
}

function contextDigest(opts?: KmsOptions): Buffer {
  return createHash('sha256').update(canonicalContext(opts)).digest();
}

/**
 * Azure Key Vault implementation of the unified Kms interface, for RSA keys in
 * Key Vault (Standard or Premium) or Managed HSM, using RSA-OAEP-256.
 *
 * Key Vault RSA encryption takes no additional authenticated data, so the
 * encryption context is bound client-side: the SHA-256 digest of the canonical
 * context is encrypted in front of the payload and checked in constant time on
 * decrypt, with the same layout as the Go and Python SDKs. Anyone holding the
 * public key can produce a valid ciphertext, and the payload limit is the
 * RSA-OAEP-256 limit minus 32 bytes (158 bytes for RSA 2048).
 *
 * A keyId without a version is resolved to the current version with getKey,
 * which needs the keys/get permission besides keys/encrypt and keys/decrypt.
 */
export class KeyVaultKms implements Kms {
  private readonly credential: ReturnType<typeof azureCredential>;
  private readonly vaultUrl: string;
  private readonly keyClient: KeyClient;
  private readonly cryptoClients = new Map<string, CryptographyClient>();

  constructor(creds: AzureCredentials, vault: string) {
    if (!vault) throw new InvalidCredentialsError('key vault name is required for Azure KMS');
    this.credential = azureCredential(creds);
    this.vaultUrl = vaultBaseUrl(vault);
    this.keyClient = new KeyClient(this.vaultUrl, this.credential);
  }

  private splitKeyId(keyId: string): [string, string] {
    if (keyId.startsWith('https://')) {
      const prefix = `${this.vaultUrl}keys/`;
      if (!keyId.toLowerCase().startsWith(prefix.toLowerCase())) {
        throw new ValidationError('keyId', `${keyId} is not in vault ${this.vaultUrl}`);
      }
      const parts = keyId
        .slice(prefix.length)
        .replace(/^\/+|\/+$/g, '')
        .split('/');
      if (!parts[0] || parts.length > 2) throw new ValidationError('keyId', `is malformed: ${keyId}`);
      return [parts[0], parts[1] ?? ''];
    }
    const slash = keyId.indexOf('/');
    const name = slash < 0 ? keyId : keyId.slice(0, slash);
    const version = slash < 0 ? '' : keyId.slice(slash + 1);
    if (!name || version.includes('/')) throw new ValidationError('keyId', `is malformed: ${keyId}`);
    return [name, version];
  }

  private async cryptoClient(keyId: string): Promise<CryptographyClient> {
    const [name, given] = this.splitKeyId(keyId);
    let version = given;
    if (!version) {
      let current: string | undefined;
      try {
        current = (await this.keyClient.getKey(name)).properties.version;
      } catch (err) {
        wrapProviderError('azure', 'GetKey', err);
      }
      if (!current) throw new ProviderError('azure', 'GetKey', new Error(`key ${name} has no current version`));
      version = current;
    }
    const kid = `${this.vaultUrl}keys/${name}/${version}`;
    let client = this.cryptoClients.get(kid);
    if (!client) {
      client = new CryptographyClient(kid, this.credential);
      this.cryptoClients.set(kid, client);
    }
    return client;
  }

  async encrypt(keyId: string, plaintext: Buffer | Uint8Array, opts?: KmsOptions): Promise<KmsEncryptResult> {
    validateKmsInput(keyId, plaintext);
    const client = await this.cryptoClient(keyId);
    try {
      const res = await client.encrypt({
        algorithm: RSA_OAEP_256,
        plaintext: Buffer.concat([contextDigest(opts), Buffer.from(plaintext)]),
      });
      return { ciphertext: Buffer.from(res.result), keyId: res.keyID ?? client.keyID ?? keyId };
    } catch (err) {
      wrapProviderError('azure', 'Encrypt', err);
    }
  }

  /**
   * Pass the versioned keyId returned by encrypt: a bare key name resolves to
   * the current version, which fails after rotation.
   */
  async decrypt(keyId: string, ciphertext: Buffer | Uint8Array, opts?: KmsOptions): Promise<Buffer> {
    validateKmsInput(keyId, ciphertext);
    const client = await this.cryptoClient(keyId);
    let out: Buffer;
    try {
      out = Buffer.from((await client.decrypt({ algorithm: RSA_OAEP_256, ciphertext })).result);
    } catch (err) {
      wrapProviderError('azure', 'Decrypt', err);
    }
    if (
      out.length <= CONTEXT_DIGEST_SIZE ||
      !timingSafeEqual(out.subarray(0, CONTEXT_DIGEST_SIZE), contextDigest(opts))
    ) {
      throw new ProviderError('azure', 'Decrypt', new Error('encryption context does not match the ciphertext'));
    }
    return out.subarray(CONTEXT_DIGEST_SIZE);
  }

  /** Key Vault has no data-key API, so the key is generated locally. */
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
    return 'azure';
  }
}
