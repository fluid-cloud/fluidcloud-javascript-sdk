import {
  AddTagsToResourceCommand,
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterNotFound,
  ParameterType,
  PutParameterCommand,
  paginateDescribeParameters,
  paginateGetParameterHistory,
  ResourceTypeForTagging,
  SSMClient,
} from '@aws-sdk/client-ssm';

import type { AwsCredentials } from '../../credentials/index.js';
import { NotFoundError, wrapProviderError } from '../../errors.js';
import type {
  Parameter,
  ParameterMetadata,
  Parameters,
  ParametersOperation,
  ParametersPutOptions,
  ParameterVersionMetadata,
} from '../types/index.js';
import { awsClientConfig } from './auth.js';

/** Implements Parameters for AWS SSM Parameter Store. */
export class ParameterStore implements Parameters {
  private readonly client: SSMClient;

  constructor(creds: AwsCredentials) {
    this.client = new SSMClient(awsClientConfig(creds));
  }

  async get(name: string): Promise<string> {
    let output;
    try {
      output = await this.client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    } catch (err) {
      return wrapProviderError('aws', 'GetParameter', err);
    }
    if (!output.Parameter?.Value) throw new NotFoundError(`parameter ${name} not found`);
    return output.Parameter.Value;
  }

  async getWithMetadata(name: string): Promise<Parameter> {
    let output;
    try {
      output = await this.client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    } catch (err) {
      return wrapProviderError('aws', 'GetParameter', err);
    }
    if (!output.Parameter) throw new NotFoundError(`parameter ${name} not found`);
    return {
      name: output.Parameter.Name ?? '',
      value: output.Parameter.Value ?? '',
      version: String(output.Parameter.Version ?? ''),
      createdAt: new Date(0),
      updatedAt: output.Parameter.LastModifiedDate ?? new Date(0),
      description: '',
      tags: {},
    };
  }

  async put(name: string, value: string, opts?: ParametersPutOptions): Promise<void> {
    try {
      await this.client.send(
        new PutParameterCommand({
          Name: name,
          Value: value,
          Overwrite: true,
          Type: opts?.secure ? ParameterType.SECURE_STRING : ParameterType.STRING,
          ...(opts?.description ? { Description: opts.description } : {}),
        }),
      );
    } catch (err) {
      return wrapProviderError('aws', 'PutParameter', err);
    }

    const tags = opts?.tags;
    if (!tags || Object.keys(tags).length === 0) return;

    try {
      await this.client.send(
        new AddTagsToResourceCommand({
          ResourceId: name,
          ResourceType: ResourceTypeForTagging.PARAMETER,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      );
    } catch (err) {
      return wrapProviderError('aws', 'AddTagsToResource', err);
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await this.client.send(new DeleteParameterCommand({ Name: name }));
    } catch (err) {
      wrapProviderError('aws', 'DeleteParameter', err);
    }
  }

  async list(): Promise<ParameterMetadata[]> {
    const result: ParameterMetadata[] = [];
    try {
      const paginator = paginateDescribeParameters({ client: this.client }, {});
      for await (const page of paginator) {
        for (const param of page.Parameters ?? []) {
          result.push({
            name: param.Name ?? '',
            version: String(param.Version ?? ''),
            createdAt: new Date(0),
            updatedAt: param.LastModifiedDate ?? new Date(0),
            description: param.Description ?? '',
            tags: {},
          });
        }
      }
    } catch (err) {
      return wrapProviderError('aws', 'DescribeParameters', err);
    }
    return result;
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return true;
    } catch (err) {
      if (err instanceof ParameterNotFound) return false;
      return wrapProviderError('aws', 'GetParameter', err);
    }
  }

  async getVersion(name: string, version: string): Promise<string> {
    let output;
    try {
      output = await this.client.send(new GetParameterCommand({ Name: `${name}:${version}`, WithDecryption: true }));
    } catch (err) {
      return wrapProviderError('aws', 'GetParameter(Version)', err);
    }
    if (!output.Parameter?.Value) throw new NotFoundError(`parameter ${name} version ${version} not found`);
    return output.Parameter.Value;
  }

  async listVersions(name: string): Promise<ParameterVersionMetadata[]> {
    const versions: ParameterVersionMetadata[] = [];
    let latest = 0;
    try {
      const paginator = paginateGetParameterHistory({ client: this.client }, { Name: name, WithDecryption: false });
      for await (const page of paginator) {
        for (const entry of page.Parameters ?? []) {
          const version = Number(entry.Version ?? 0);
          versions.push({
            version: String(version),
            status: 'previous',
            createdAt: entry.LastModifiedDate ?? new Date(0),
          });
          if (version > latest) latest = version;
        }
      }
    } catch (err) {
      return wrapProviderError('aws', 'GetParameterHistory', err);
    }
    const current = String(latest);
    for (const v of versions) if (v.version === current) v.status = 'current';
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
    return 'aws';
  }
}
