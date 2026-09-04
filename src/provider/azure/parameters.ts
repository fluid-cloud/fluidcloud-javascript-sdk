import { AppConfigurationClient } from '@azure/app-configuration';

import type { AzureCredentials } from '../../credentials/index.js';
import { NotFoundError, wrapProviderError } from '../../errors.js';
import type {
  Parameter,
  ParameterMetadata,
  Parameters,
  ParametersOperation,
  ParametersPutOptions,
  ParameterVersionMetadata,
} from '../types/index.js';
import { azureCredential } from './auth.js';

/**
 * Implements Parameters for Azure App Configuration. There are no version
 * numbers — the setting's ETag identifies the revision, and Put ignores
 * description/tags since azappconfig's SetSetting does not accept them.
 */
export class AppConfigurationParameters implements Parameters {
  private readonly client: AppConfigurationClient;

  constructor(creds: AzureCredentials, endpoint: string) {
    this.client = new AppConfigurationClient(endpoint, azureCredential(creds));
  }

  async get(name: string): Promise<string> {
    let resp;
    try {
      resp = await this.client.getConfigurationSetting({ key: name });
    } catch (err) {
      return wrapProviderError('azure', 'GetSetting', err);
    }
    if (resp.value === undefined) throw new NotFoundError(`parameter ${name} not found`);
    return resp.value;
  }

  async getWithMetadata(name: string): Promise<Parameter> {
    let resp;
    try {
      resp = await this.client.getConfigurationSetting({ key: name });
    } catch (err) {
      return wrapProviderError('azure', 'GetSetting', err);
    }
    return {
      name,
      value: resp.value ?? '',
      version: resp.etag ?? '',
      createdAt: new Date(0),
      updatedAt: resp.lastModified ?? new Date(0),
      description: '',
      tags: resp.tags ?? {},
    };
  }

  async put(name: string, value: string, _opts?: ParametersPutOptions): Promise<void> {
    try {
      await this.client.setConfigurationSetting({ key: name, value });
    } catch (err) {
      wrapProviderError('azure', 'SetSetting', err);
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await this.client.deleteConfigurationSetting({ key: name });
    } catch (err) {
      wrapProviderError('azure', 'DeleteSetting', err);
    }
  }

  async list(): Promise<ParameterMetadata[]> {
    const result: ParameterMetadata[] = [];
    try {
      for await (const setting of this.client.listConfigurationSettings({ keyFilter: '*', labelFilter: '*' })) {
        result.push({
          name: setting.key ?? '',
          version: setting.etag ?? '',
          createdAt: new Date(0),
          updatedAt: setting.lastModified ?? new Date(0),
          description: '',
          tags: setting.tags ?? {},
        });
      }
    } catch (err) {
      return wrapProviderError('azure', 'ListSettings', err);
    }
    return result;
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.getConfigurationSetting({ key: name });
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(name: string, version: string): Promise<string> {
    try {
      for await (const setting of this.client.listRevisions({ keyFilter: name })) {
        if (setting.etag !== version) continue;
        return setting.value ?? '';
      }
    } catch (err) {
      return wrapProviderError('azure', 'ListRevisions', err);
    }
    throw new NotFoundError(`parameter ${name} version ${version} not found`);
  }

  async listVersions(name: string): Promise<ParameterVersionMetadata[]> {
    const versions: ParameterVersionMetadata[] = [];
    try {
      for await (const setting of this.client.listRevisions({ keyFilter: name })) {
        versions.push({
          version: setting.etag ?? '',
          status: versions.length === 0 ? 'current' : 'previous',
          createdAt: setting.lastModified ?? new Date(0),
        });
      }
    } catch (err) {
      return wrapProviderError('azure', 'ListRevisions', err);
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
    return 'azure';
  }
}
