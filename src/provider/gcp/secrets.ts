import { protos, SecretManagerServiceClient } from '@google-cloud/secret-manager';

import type { GcpCredentials } from '../../credentials/index.js';
import { UnsupportedError, wrapProviderError } from '../../errors.js';
import type {
  Secret,
  SecretMetadata,
  Secrets,
  SecretsOperation,
  SecretsPutOptions,
  SecretVersionMetadata,
} from '../types/secrets.js';
import { gcpClientConfig } from './auth.js';

const GRPC_ALREADY_EXISTS = 6;

type ITimestamp = protos.google.protobuf.ITimestamp;

function protoDate(ts?: ITimestamp | null): Date {
  if (!ts?.seconds) return new Date(0);
  const millis = Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6);
  return new Date(millis);
}

function grpcCode(err: unknown): number | undefined {
  return (err as { code?: number } | null)?.code;
}

function lastSegment(name?: string | null): string {
  return (name ?? '').split('/').pop() ?? '';
}

const SECRET_VERSION_STATE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(protos.google.cloud.secretmanager.v1.SecretVersion.State)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [v as number, k]),
);

function versionStatus(state?: protos.google.cloud.secretmanager.v1.SecretVersion.State | string | null): string {
  if (state === undefined || state === null) return 'STATE_UNSPECIFIED';
  if (typeof state === 'string') return state;
  return SECRET_VERSION_STATE_NAMES[state] ?? 'STATE_UNSPECIFIED';
}

/** GCP Secret Manager implementation of the unified Secrets interface. */
export class SecretManagerSecrets implements Secrets {
  private readonly client: SecretManagerServiceClient;
  private readonly projectId: string;

  constructor(creds: GcpCredentials) {
    const cfg = gcpClientConfig(creds);
    this.client = new SecretManagerServiceClient({ projectId: cfg.projectId, credentials: cfg.credentials });
    this.projectId = creds.projectId;
  }

  private parent(): string {
    return `projects/${this.projectId}`;
  }

  private secretName(name: string): string {
    return `projects/${this.projectId}/secrets/${name}`;
  }

  private versionName(name: string, version: string): string {
    return `projects/${this.projectId}/secrets/${name}/versions/${version}`;
  }

  private async access(version: string): Promise<Buffer> {
    try {
      const [resp] = await this.client.accessSecretVersion({ name: version });
      const data = resp.payload?.data ?? new Uint8Array();
      return Buffer.from(data as Uint8Array);
    } catch (err) {
      wrapProviderError('gcp', 'AccessSecretVersion', err);
    }
  }

  async get(name: string): Promise<string> {
    const data = await this.access(this.versionName(name, 'latest'));
    return data.toString('utf-8');
  }

  async getBinary(name: string): Promise<Buffer> {
    return this.access(this.versionName(name, 'latest'));
  }

  async getVersion(name: string, version: string): Promise<string> {
    const data = await this.access(this.versionName(name, version));
    return data.toString('utf-8');
  }

  async getWithMetadata(name: string): Promise<Secret> {
    const data = await this.access(this.versionName(name, 'latest'));
    try {
      const [meta] = await this.client.getSecret({ name: this.secretName(name) });
      return {
        name,
        value: data.toString('utf-8'),
        version: '',
        createdAt: protoDate(meta.createTime),
        updatedAt: new Date(0),
        description: '',
        tags: (meta.labels as Record<string, string>) ?? {},
      };
    } catch (err) {
      wrapProviderError('gcp', 'GetSecret', err);
    }
  }

  private async putBytes(name: string, data: Buffer, opts?: SecretsPutOptions): Promise<void> {
    try {
      await this.client.createSecret({
        parent: this.parent(),
        secretId: name,
        secret: {
          replication: { automatic: {} },
          labels: opts?.tags,
        },
      });
    } catch (err) {
      if (grpcCode(err) !== GRPC_ALREADY_EXISTS) wrapProviderError('gcp', 'CreateSecret', err);
    }

    try {
      await this.client.addSecretVersion({
        parent: this.secretName(name),
        payload: { data },
      });
    } catch (err) {
      wrapProviderError('gcp', 'AddSecretVersion', err);
    }
  }

  async put(name: string, value: string, opts?: SecretsPutOptions): Promise<void> {
    await this.putBytes(name, Buffer.from(value, 'utf-8'), opts);
  }

  async putBinary(name: string, data: Buffer | Uint8Array, opts?: SecretsPutOptions): Promise<void> {
    await this.putBytes(name, Buffer.isBuffer(data) ? data : Buffer.from(data), opts);
  }

  async delete(name: string): Promise<void> {
    try {
      await this.client.deleteSecret({ name: this.secretName(name) });
    } catch (err) {
      wrapProviderError('gcp', 'DeleteSecret', err);
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.getSecret({ name: this.secretName(name) });
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<SecretMetadata[]> {
    const out: SecretMetadata[] = [];
    try {
      for await (const sec of this.client.listSecretsAsync({ parent: this.parent() })) {
        out.push({
          name: lastSegment(sec.name),
          version: '',
          createdAt: protoDate(sec.createTime),
          updatedAt: new Date(0),
          description: '',
          tags: (sec.labels as Record<string, string>) ?? {},
        });
      }
    } catch (err) {
      wrapProviderError('gcp', 'ListSecrets', err);
    }
    return out;
  }

  async listVersions(name: string): Promise<SecretVersionMetadata[]> {
    const out: SecretVersionMetadata[] = [];
    try {
      for await (const v of this.client.listSecretVersionsAsync({ parent: this.secretName(name) })) {
        out.push({
          version: lastSegment(v.name),
          status: versionStatus(v.state),
          createdAt: protoDate(v.createTime),
        });
      }
    } catch (err) {
      wrapProviderError('gcp', 'ListSecretVersions', err);
    }
    return out;
  }

  async restore(_name: string): Promise<void> {
    throw new UnsupportedError(
      'gcp',
      'restore',
      'Secret Manager deletes are permanent (no soft-delete/undelete).',
      'recreate the secret with put()',
    );
  }

  async rotateSecret(_name: string): Promise<void> {
    throw new UnsupportedError(
      'gcp',
      'rotateSecret',
      'Secret Manager has no on-demand rotation trigger.',
      'add a new version with put(), or configure rotation policies',
    );
  }

  supports(op: SecretsOperation): boolean {
    if (op === 'restore' || op === 'rotate') return false;
    return true;
  }

  provider(): string {
    return 'gcp';
  }
}
