import { DecryptCommand, EncryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';

import type { AwsCredentials } from '../../credentials/index.js';
import { wrapProviderError } from '../../errors.js';
import { kmsContext, supportsKmsOperation, validateDataKeySize, validateKmsInput } from '../shared/kms.js';
import type { DataKey, Kms, KmsEncryptResult, KmsOperation, KmsOptions } from '../types/kms.js';
import { awsClientConfig } from './auth.js';

/**
 * AWS KMS implementation of the unified Kms interface, for symmetric
 * encryption keys, whose EncryptionContext is native additional authenticated
 * data.
 */
export class AwsKms implements Kms {
  private readonly client: KMSClient;

  constructor(creds: AwsCredentials, region?: string) {
    this.client = new KMSClient(awsClientConfig(creds, region));
  }

  async encrypt(keyId: string, plaintext: Buffer | Uint8Array, opts?: KmsOptions): Promise<KmsEncryptResult> {
    validateKmsInput(keyId, plaintext);
    try {
      const out = await this.client.send(
        new EncryptCommand({ KeyId: keyId, Plaintext: plaintext, EncryptionContext: kmsContext(opts) }),
      );
      return { ciphertext: Buffer.from(out.CiphertextBlob ?? new Uint8Array()), keyId: out.KeyId ?? '' };
    } catch (err) {
      wrapProviderError('aws', 'Encrypt', err);
    }
  }

  /** Pins KeyId, as AWS recommends, so a ciphertext produced under another key is refused. */
  async decrypt(keyId: string, ciphertext: Buffer | Uint8Array, opts?: KmsOptions): Promise<Buffer> {
    validateKmsInput(keyId, ciphertext);
    try {
      const out = await this.client.send(
        new DecryptCommand({ KeyId: keyId, CiphertextBlob: ciphertext, EncryptionContext: kmsContext(opts) }),
      );
      return Buffer.from(out.Plaintext ?? new Uint8Array());
    } catch (err) {
      wrapProviderError('aws', 'Decrypt', err);
    }
  }

  async generateDataKey(keyId: string, numBytes: number, opts?: KmsOptions): Promise<DataKey> {
    validateKmsInput(keyId);
    validateDataKeySize(numBytes);
    try {
      const out = await this.client.send(
        new GenerateDataKeyCommand({ KeyId: keyId, NumberOfBytes: numBytes, EncryptionContext: kmsContext(opts) }),
      );
      return {
        plaintext: Buffer.from(out.Plaintext ?? new Uint8Array()),
        ciphertext: Buffer.from(out.CiphertextBlob ?? new Uint8Array()),
        keyId: out.KeyId ?? '',
      };
    } catch (err) {
      wrapProviderError('aws', 'GenerateDataKey', err);
    }
  }

  supports(op: KmsOperation): boolean {
    return supportsKmsOperation(op);
  }

  provider(): string {
    return 'aws';
  }
}
