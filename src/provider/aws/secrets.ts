import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretVersionIdsCommand,
  paginateListSecrets,
  PutSecretValueCommand,
  RestoreSecretCommand,
  SecretsManagerClient,
  type Tag,
} from '@aws-sdk/client-secrets-manager';

import type { AwsCredentials } from '../../credentials/index.js';
import { wrapProviderError } from '../../errors.js';
import type {
  Secret,
  SecretMetadata,
  Secrets,
  SecretsOperation,
  SecretsPutOptions,
  SecretVersionMetadata,
} from '../types/secrets.js';
import { awsClientConfig } from './auth.js';

function toTags(tags?: Record<string, string>): Tag[] | undefined {
  if (!tags || Object.keys(tags).length === 0) return undefined;
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

/** AWS Secrets Manager implementation of the unified Secrets interface. */
export class SecretsManager implements Secrets {
  private readonly client: SecretsManagerClient;

  constructor(creds: AwsCredentials) {
    this.client = new SecretsManagerClient(awsClientConfig(creds));
  }

  async get(name: string): Promise<string> {
    try {
      const output = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      return output.SecretString ?? '';
    } catch (err) {
      wrapProviderError('aws', 'GetSecretValue', err);
    }
  }

  async getWithMetadata(name: string): Promise<Secret> {
    try {
      const output = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      return {
        name: output.Name ?? '',
        value: output.SecretString ?? '',
        version: output.VersionId ?? '',
        createdAt: output.CreatedDate ?? new Date(0),
        updatedAt: new Date(0),
        description: '',
        tags: {},
      };
    } catch (err) {
      wrapProviderError('aws', 'GetSecretValue', err);
    }
  }

  async put(name: string, value: string, opts?: SecretsPutOptions): Promise<void> {
    let exists = true;
    try {
      await this.client.send(new DescribeSecretCommand({ SecretId: name }));
    } catch {
      exists = false;
    }

    if (!exists) {
      try {
        await this.client.send(
          new CreateSecretCommand({
            Name: name,
            SecretString: value,
            Description: opts?.description || undefined,
            Tags: toTags(opts?.tags),
          }),
        );
      } catch (err) {
        wrapProviderError('aws', 'CreateSecret', err);
      }
      return;
    }

    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } catch (err) {
      wrapProviderError('aws', 'PutSecretValue', err);
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await this.client.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
    } catch (err) {
      wrapProviderError('aws', 'DeleteSecret', err);
    }
  }

  async list(): Promise<SecretMetadata[]> {
    const result: SecretMetadata[] = [];
    try {
      for await (const page of paginateListSecrets({ client: this.client }, {})) {
        for (const secret of page.SecretList ?? []) {
          const tags: Record<string, string> = {};
          for (const tag of secret.Tags ?? []) {
            if (tag.Key) tags[tag.Key] = tag.Value ?? '';
          }
          result.push({
            name: secret.Name ?? '',
            version: '',
            createdAt: secret.CreatedDate ?? new Date(0),
            updatedAt: secret.LastChangedDate ?? new Date(0),
            description: secret.Description ?? '',
            tags,
          });
        }
      }
    } catch (err) {
      wrapProviderError('aws', 'ListSecrets', err);
    }
    return result;
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.send(new DescribeSecretCommand({ SecretId: name }));
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(name: string, version: string): Promise<string> {
    try {
      const output = await this.client.send(new GetSecretValueCommand({ SecretId: name, VersionId: version }));
      return output.SecretString ?? '';
    } catch (err) {
      wrapProviderError('aws', 'GetSecretValue(Version)', err);
    }
  }

  async listVersions(name: string): Promise<SecretVersionMetadata[]> {
    try {
      const output = await this.client.send(new ListSecretVersionIdsCommand({ SecretId: name }));
      return (output.Versions ?? []).map((v) => {
        let status = 'deprecated';
        for (const stage of v.VersionStages ?? []) {
          if (stage === 'AWSCURRENT') {
            status = 'current';
            break;
          }
          if (stage === 'AWSPREVIOUS') status = 'previous';
        }
        return {
          version: v.VersionId ?? '',
          status,
          createdAt: v.CreatedDate ?? new Date(0),
        };
      });
    } catch (err) {
      wrapProviderError('aws', 'ListSecretVersionIds', err);
    }
  }

  async putBinary(name: string, data: Buffer | Uint8Array, opts?: SecretsPutOptions): Promise<void> {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let exists = true;
    try {
      await this.client.send(new DescribeSecretCommand({ SecretId: name }));
    } catch {
      exists = false;
    }

    if (!exists) {
      try {
        await this.client.send(
          new CreateSecretCommand({
            Name: name,
            SecretBinary: bytes,
            Description: opts?.description || undefined,
            Tags: toTags(opts?.tags),
          }),
        );
      } catch (err) {
        wrapProviderError('aws', 'CreateSecret(Binary)', err);
      }
      return;
    }

    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretBinary: bytes }));
    } catch (err) {
      wrapProviderError('aws', 'PutSecretValue(Binary)', err);
    }
  }

  async getBinary(name: string): Promise<Buffer> {
    try {
      const output = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      if (output.SecretBinary) return Buffer.from(output.SecretBinary);
      if (output.SecretString !== undefined) return Buffer.from(output.SecretString, 'utf-8');
      return Buffer.alloc(0);
    } catch (err) {
      wrapProviderError('aws', 'GetSecretValue(Binary)', err);
    }
  }

  async restore(name: string): Promise<void> {
    try {
      await this.client.send(new RestoreSecretCommand({ SecretId: name }));
    } catch (err) {
      wrapProviderError('aws', 'RestoreSecret', err);
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
    return 'aws';
  }
}
