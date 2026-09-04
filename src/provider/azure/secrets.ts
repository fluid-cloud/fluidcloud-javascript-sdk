import { SecretClient } from '@azure/keyvault-secrets';

import type { AzureCredentials } from '../../credentials/index.js';
import { wrapProviderError } from '../../errors.js';
import type {
  Secret,
  SecretMetadata,
  Secrets,
  SecretsOperation,
  SecretsPutOptions,
  SecretVersionMetadata,
} from '../types/secrets.js';
import { azureCredential } from './auth.js';

function decodeBase64OrRaw(value: string): Buffer {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') === value) return decoded;
  } catch {}
  return Buffer.from(value, 'utf-8');
}

/** Azure Key Vault implementation of the unified Secrets interface. */
export class KeyVaultSecrets implements Secrets {
  private readonly client: SecretClient;

  constructor(creds: AzureCredentials, keyVaultName: string) {
    this.client = new SecretClient(`https://${keyVaultName}.vault.azure.net`, azureCredential(creds));
  }

  async get(name: string): Promise<string> {
    try {
      const secret = await this.client.getSecret(name);
      return secret.value ?? '';
    } catch (err) {
      wrapProviderError('azure', 'GetSecret', err);
    }
  }

  async getWithMetadata(name: string): Promise<Secret> {
    try {
      const secret = await this.client.getSecret(name);
      const tags: Record<string, string> = {};
      for (const [key, value] of Object.entries(secret.properties.tags ?? {})) {
        if (value !== undefined) tags[key] = value;
      }
      return {
        name,
        value: secret.value ?? '',
        version: secret.properties.id ?? '',
        createdAt: secret.properties.createdOn ?? new Date(0),
        updatedAt: secret.properties.updatedOn ?? new Date(0),
        description: '',
        tags,
      };
    } catch (err) {
      wrapProviderError('azure', 'GetSecret', err);
    }
  }

  async put(name: string, value: string, opts?: SecretsPutOptions): Promise<void> {
    try {
      await this.client.setSecret(name, value, { tags: opts?.tags });
    } catch (err) {
      wrapProviderError('azure', 'SetSecret', err);
    }
  }

  async delete(name: string): Promise<void> {
    try {
      const poller = await this.client.beginDeleteSecret(name);
      await poller.pollUntilDone();
    } catch (err) {
      wrapProviderError('azure', 'DeleteSecret', err);
    }
  }

  async list(): Promise<SecretMetadata[]> {
    const result: SecretMetadata[] = [];
    try {
      for await (const props of this.client.listPropertiesOfSecrets()) {
        const tags: Record<string, string> = {};
        for (const [key, value] of Object.entries(props.tags ?? {})) {
          if (value !== undefined) tags[key] = value;
        }
        result.push({
          name: props.name,
          version: props.version ?? '',
          createdAt: props.createdOn ?? new Date(0),
          updatedAt: props.updatedOn ?? new Date(0),
          description: '',
          tags,
        });
      }
    } catch (err) {
      wrapProviderError('azure', 'ListSecrets', err);
    }
    return result;
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.getSecret(name);
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(name: string, version: string): Promise<string> {
    try {
      const secret = await this.client.getSecret(name, { version });
      return secret.value ?? '';
    } catch (err) {
      wrapProviderError('azure', 'GetSecret(Version)', err);
    }
  }

  async listVersions(name: string): Promise<SecretVersionMetadata[]> {
    const result: SecretVersionMetadata[] = [];
    try {
      for await (const props of this.client.listPropertiesOfSecretVersions(name)) {
        result.push({
          version: props.version ?? '',
          status: props.enabled ? 'current' : 'deprecated',
          createdAt: props.createdOn ?? new Date(0),
        });
      }
    } catch (err) {
      wrapProviderError('azure', 'ListSecretVersions', err);
    }
    return result;
  }

  async putBinary(name: string, data: Buffer | Uint8Array, opts?: SecretsPutOptions): Promise<void> {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await this.put(name, bytes.toString('base64'), opts);
  }

  async getBinary(name: string): Promise<Buffer> {
    const value = await this.get(name);
    return decodeBase64OrRaw(value);
  }

  async restore(name: string): Promise<void> {
    try {
      const poller = await this.client.beginRecoverDeletedSecret(name);
      await poller.pollUntilDone();
    } catch (err) {
      wrapProviderError('azure', 'RecoverDeletedSecret', err);
    }
  }

  async rotateSecret(name: string): Promise<void> {
    const value = await this.get(name);
    await this.put(name, value);
  }

  supports(_op: SecretsOperation): boolean {
    return true;
  }

  provider(): string {
    return 'azure';
  }
}
