/** A KMS operation, for capability introspection via supports(). */
export type KmsOperation = 'encrypt' | 'decrypt' | 'generate_data_key';

export interface KmsOptions {
  /**
   * Non-secret key/value data bound to the ciphertext. Decrypt fails unless it
   * is given the exact same context. It may appear in provider audit logs, so it
   * must never hold secrets.
   */
  encryptionContext?: Record<string, string>;
}

export interface KmsEncryptResult {
  ciphertext: Buffer;
  /**
   * The exact key (and version, where the provider exposes one) that produced
   * the ciphertext. Store it beside the ciphertext and pass it to decrypt so
   * decryption keeps working after the key is rotated.
   */
  keyId: string;
}

/** A freshly generated data key and its copy encrypted under a KMS key. */
export interface DataKey {
  plaintext: Buffer;
  ciphertext: Buffer;
  /** Same meaning as KmsEncryptResult.keyId. */
  keyId: string;
}

/**
 * Unified cloud key management. Keys never leave the provider; only small
 * payloads such as data keys are encrypted. Ciphertexts are interchangeable
 * with the Go and Python SDKs.
 *
 * keyId formats per provider:
 *   - AWS: key ID, key ARN, alias name ("alias/x") or alias ARN
 *   - Azure: key name, "name/version", or the full key identifier URL
 *   - GCP: CryptoKey resource name, or a CryptoKeyVersion name
 *   - OCI: key OCID
 */
export interface Kms {
  /** Encrypts a small payload (a data key, a password) under keyId. */
  encrypt(keyId: string, plaintext: Buffer | Uint8Array, opts?: KmsOptions): Promise<KmsEncryptResult>;

  /** Reverses encrypt. keyId should be the keyId returned by encrypt. */
  decrypt(keyId: string, ciphertext: Buffer | Uint8Array, opts?: KmsOptions): Promise<Buffer>;

  /**
   * Returns a random data key of numBytes and its copy encrypted under keyId.
   * AWS and OCI generate it in the service; Azure and GCP have no such API, so
   * it is generated locally and then encrypted.
   */
  generateDataKey(keyId: string, numBytes: number, opts?: KmsOptions): Promise<DataKey>;

  /** Reports whether this provider implements the operation. */
  supports(op: KmsOperation): boolean;

  /** Returns the provider name, e.g. "aws". */
  provider(): string;
}
