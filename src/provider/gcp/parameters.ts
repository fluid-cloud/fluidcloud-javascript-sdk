import { ParameterManagerClient, protos } from '@google-cloud/parametermanager';
import type { ClientOptions } from 'google-gax';

import type { GcpCredentials } from '../../credentials/index.js';
import { NotFoundError, wrapProviderError } from '../../errors.js';
import type {
  Parameter,
  ParameterMetadata,
  Parameters,
  ParametersOperation,
  ParametersPutOptions,
  ParameterVersionMetadata,
} from '../types/index.js';
import { gcpClientConfig } from './auth.js';

type ITimestamp = protos.google.protobuf.ITimestamp;

const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;

function grpcCode(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: number }).code : undefined;
}

function timestampMillis(ts?: ITimestamp | null): number {
  if (!ts) return 0;
  return Number(ts.seconds ?? 0) * 1000 + Math.floor(Number(ts.nanos ?? 0) / 1e6);
}

function timestampDate(ts?: ITimestamp | null): Date {
  return new Date(timestampMillis(ts));
}

function decodePayload(data?: Uint8Array | string | null): string {
  if (!data) return '';
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
}

function baseName(name?: string | null): string {
  return (name ?? '').split('/').pop() ?? '';
}

/**
 * Implements Parameters for GCP Parameter Manager (global location). Get
 * returns the payload of the newest enabled version of the parameter.
 */
export class ParameterManagerParameters implements Parameters {
  private readonly client: ParameterManagerClient;
  private readonly projectId: string;

  constructor(creds: GcpCredentials) {
    this.client = new ParameterManagerClient(gcpClientConfig(creds) as unknown as ClientOptions);
    this.projectId = creds.projectId;
  }

  private parent(): string {
    return `projects/${this.projectId}/locations/global`;
  }

  private parameterName(name: string): string {
    return `${this.parent()}/parameters/${name}`;
  }

  private versionName(name: string, version: string): string {
    return `${this.parameterName(name)}/versions/${version}`;
  }

  private async newestEnabledVersion(name: string): Promise<string> {
    let newest = '';
    let newestMillis = -1;
    try {
      for await (const version of this.client.listParameterVersionsAsync({ parent: this.parameterName(name) })) {
        if (version.disabled) continue;
        const created = timestampMillis(version.createTime);
        if (!newest || created > newestMillis) {
          newest = version.name ?? '';
          newestMillis = created;
        }
      }
    } catch (err) {
      return wrapProviderError('gcp', 'ListParameterVersions', err);
    }
    if (!newest) throw new NotFoundError(`parameter ${name} has no enabled version`);
    return newest;
  }

  async get(name: string): Promise<string> {
    const newest = await this.newestEnabledVersion(name);
    try {
      const [resp] = await this.client.getParameterVersion({ name: newest });
      return decodePayload(resp.payload?.data);
    } catch (err) {
      return wrapProviderError('gcp', 'GetParameterVersion', err);
    }
  }

  async getWithMetadata(name: string): Promise<Parameter> {
    const newest = await this.newestEnabledVersion(name);
    let version;
    try {
      [version] = await this.client.getParameterVersion({ name: newest });
    } catch (err) {
      return wrapProviderError('gcp', 'GetParameterVersion', err);
    }
    let param;
    try {
      [param] = await this.client.getParameter({ name: this.parameterName(name) });
    } catch (err) {
      return wrapProviderError('gcp', 'GetParameter', err);
    }
    return {
      name,
      value: decodePayload(version.payload?.data),
      version: baseName(version.name),
      createdAt: timestampDate(param.createTime),
      updatedAt: timestampDate(version.createTime),
      description: '',
      tags: param.labels ?? {},
    };
  }

  async put(name: string, value: string, opts?: ParametersPutOptions): Promise<void> {
    try {
      await this.client.createParameter({
        parent: this.parent(),
        parameterId: name,
        parameter: { labels: opts?.tags },
      });
    } catch (err) {
      if (grpcCode(err) !== GRPC_ALREADY_EXISTS) return wrapProviderError('gcp', 'CreateParameter', err);
    }

    try {
      await this.client.createParameterVersion({
        parent: this.parameterName(name),
        parameterVersionId: `v-${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        parameterVersion: { payload: { data: Buffer.from(value, 'utf8') } },
      });
    } catch (err) {
      wrapProviderError('gcp', 'CreateParameterVersion', err);
    }
  }

  async delete(name: string): Promise<void> {
    try {
      for await (const version of this.client.listParameterVersionsAsync({ parent: this.parameterName(name) })) {
        try {
          await this.client.deleteParameterVersion({ name: version.name ?? '' });
        } catch (err) {
          if (grpcCode(err) !== GRPC_NOT_FOUND) return wrapProviderError('gcp', 'DeleteParameterVersion', err);
        }
      }
    } catch (err) {
      return wrapProviderError('gcp', 'ListParameterVersions', err);
    }

    try {
      await this.client.deleteParameter({ name: this.parameterName(name) });
    } catch (err) {
      wrapProviderError('gcp', 'DeleteParameter', err);
    }
  }

  async list(): Promise<ParameterMetadata[]> {
    const result: ParameterMetadata[] = [];
    try {
      for await (const param of this.client.listParametersAsync({ parent: this.parent() })) {
        result.push({
          name: baseName(param.name),
          version: '',
          createdAt: timestampDate(param.createTime),
          updatedAt: timestampDate(param.updateTime),
          description: '',
          tags: param.labels ?? {},
        });
      }
    } catch (err) {
      return wrapProviderError('gcp', 'ListParameters', err);
    }
    return result;
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.getParameter({ name: this.parameterName(name) });
      return true;
    } catch (err) {
      if (grpcCode(err) === GRPC_NOT_FOUND) return false;
      return wrapProviderError('gcp', 'GetParameter', err);
    }
  }

  async getVersion(name: string, version: string): Promise<string> {
    try {
      const [resp] = await this.client.getParameterVersion({ name: this.versionName(name, version) });
      return decodePayload(resp.payload?.data);
    } catch (err) {
      return wrapProviderError('gcp', 'GetParameterVersion', err);
    }
  }

  async listVersions(name: string): Promise<ParameterVersionMetadata[]> {
    const versions: ParameterVersionMetadata[] = [];
    try {
      for await (const version of this.client.listParameterVersionsAsync({ parent: this.parameterName(name) })) {
        versions.push({
          version: baseName(version.name),
          status: version.disabled ? 'disabled' : 'enabled',
          createdAt: timestampDate(version.createTime),
        });
      }
    } catch (err) {
      return wrapProviderError('gcp', 'ListParameterVersions', err);
    }
    return versions;
  }

  supports(op: ParametersOperation): boolean {
    switch (op) {
      case 'get':
      case 'get_metadata':
      case 'get_version':
      case 'put':
      case 'delete':
      case 'list':
      case 'list_versions':
      case 'exists':
        return true;
      default:
        return false;
    }
  }

  provider(): string {
    return 'gcp';
  }
}
