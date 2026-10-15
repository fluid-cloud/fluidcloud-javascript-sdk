import { KmsCryptoClient, KmsVaultClient, models } from 'oci-keymanagement';

import type { OciCredentials } from '../../credentials/index.js';
import { InvalidCredentialsError, ProviderError, wrapProviderError } from '../../errors.js';
import {
  kmsContext,
  randomKeyBytes,
  supportsKmsOperation,
  validateDataKeySize,
  validateKmsInput,
} from '../shared/kms.js';
import type { DataKey, Kms, KmsEncryptResult, KmsOperation, KmsOptions } from '../types/kms.js';
import { ociAuthProvider } from './auth.js';

const NATIVE_DATA_KEY_SIZES = new Set([16, 24, 32]);

/** Returns the cryptographic endpoint of a vault. Needs permission to read the vault. */
export async function resolveCryptoEndpoint(creds: OciCredentials, vaultOcid: string): Promise<string> {
  if (!vaultOcid) throw new InvalidCredentialsError('vaultOcid is required to resolve the crypto endpoint');
  const client = new KmsVaultClient({ authenticationDetailsProvider: ociAuthProvider(creds) });
  let endpoint: string | undefined;
  try {
    endpoint = (await client.getVault({ vaultId: vaultOcid })).vault.cryptoEndpoint;
  } catch (err) {
    wrapProviderError('oci', 'GetVault', err);
  }
  if (!endpoint) throw new ProviderError('oci', 'GetVault', new Error(`vault ${vaultOcid} has no crypto endpoint`));
  return endpoint;
}

function decodePlaintext(op: string, encoded?: string): Buffer {
  if (!encoded) throw new ProviderError('oci', op, new Error('empty plaintext'));
  return Buffer.from(encoded, 'base64');
}

/**
 * OCI Vault implementation of the unified Kms interface, for AES master
 * encryption keys (AES_256_GCM). The encryption context is passed as
 * associatedData, which OCI binds to the ciphertext natively. Use
 * resolveCryptoEndpoint to look the endpoint up from the vault OCID.
 */
export class VaultKms implements Kms {
  private readonly client: KmsCryptoClient;

  constructor(creds: OciCredentials, cryptoEndpoint: string) {
    if (!cryptoEndpoint) throw new InvalidCredentialsError('crypto endpoint is required for OCI KMS');
    this.client = new KmsCryptoClient({ authenticationDetailsProvider: ociAuthProvider(creds) });
    this.client.endpoint = cryptoEndpoint;
  }

  async encrypt(keyId: string, plaintext: Buffer | Uint8Array, opts?: KmsOptions): Promise<KmsEncryptResult> {
    validateKmsInput(keyId, plaintext);
    let data: models.EncryptedData;
    try {
      data = (
        await this.client.encrypt({
          encryptDataDetails: {
            keyId,
            plaintext: Buffer.from(plaintext).toString('base64'),
            associatedData: kmsContext(opts),
            encryptionAlgorithm: models.EncryptDataDetails.EncryptionAlgorithm.Aes256Gcm,
          },
        })
      ).encryptedData;
    } catch (err) {
      wrapProviderError('oci', 'Encrypt', err);
    }
    // OCI ciphertexts are opaque strings, stored as their bytes like the Go and Python SDKs.
    if (!data.ciphertext) throw new ProviderError('oci', 'Encrypt', new Error('empty ciphertext'));
    return { ciphertext: Buffer.from(data.ciphertext, 'utf8'), keyId: data.keyId || keyId };
  }

  /** Only the key OCID is needed: AES ciphertexts carry their key version. */
  async decrypt(keyId: string, ciphertext: Buffer | Uint8Array, opts?: KmsOptions): Promise<Buffer> {
    validateKmsInput(keyId, ciphertext);
    let plaintext: string;
    try {
      plaintext = (
        await this.client.decrypt({
          decryptDataDetails: {
            keyId,
            ciphertext: Buffer.from(ciphertext).toString('utf8'),
            associatedData: kmsContext(opts),
            encryptionAlgorithm: models.DecryptDataDetails.EncryptionAlgorithm.Aes256Gcm,
          },
        })
      ).decryptedData.plaintext;
    } catch (err) {
      wrapProviderError('oci', 'Decrypt', err);
    }
    return decodePlaintext('Decrypt', plaintext);
  }

  /**
   * Uses GenerateDataEncryptionKey for 16, 24 or 32 bytes (the only lengths OCI
   * accepts) and generates other sizes locally.
   */
  async generateDataKey(keyId: string, numBytes: number, opts?: KmsOptions): Promise<DataKey> {
    validateDataKeySize(numBytes);
    if (!NATIVE_DATA_KEY_SIZES.has(numBytes)) {
      const plaintext = randomKeyBytes(numBytes);
      const res = await this.encrypt(keyId, plaintext, opts);
      return { plaintext, ciphertext: res.ciphertext, keyId: res.keyId };
    }
    validateKmsInput(keyId);
    let key: models.GeneratedKey;
    try {
      key = (
        await this.client.generateDataEncryptionKey({
          generateKeyDetails: {
            keyId,
            includePlaintextKey: true,
            keyShape: { algorithm: models.KeyShape.Algorithm.Aes, length: numBytes },
            associatedData: kmsContext(opts),
          },
        })
      ).generatedKey;
    } catch (err) {
      wrapProviderError('oci', 'GenerateDataEncryptionKey', err);
    }
    const plaintext = decodePlaintext('GenerateDataEncryptionKey', key.plaintext);
    if (!key.ciphertext) throw new ProviderError('oci', 'GenerateDataEncryptionKey', new Error('empty ciphertext'));
    return { plaintext, ciphertext: Buffer.from(key.ciphertext, 'utf8'), keyId };
  }

  supports(op: KmsOperation): boolean {
    return supportsKmsOperation(op);
  }

  provider(): string {
    return 'oci';
  }
}
