import type {
  Parameter,
  ParameterMetadata,
  Parameters,
  ParametersOperation,
  ParametersPutOptions,
  ParameterVersionMetadata,
  Secrets,
} from '../types/index.js';

/**
 * Implements Parameters for OCI, which has no native parameter store;
 * parameters are served from Vault secrets.
 */
export class VaultParameters implements Parameters {
  private readonly vault: Secrets;

  constructor(vault: Secrets) {
    this.vault = vault;
  }

  async get(name: string): Promise<string> {
    return this.vault.get(name);
  }

  async getWithMetadata(name: string): Promise<Parameter> {
    const secret = await this.vault.getWithMetadata(name);
    return {
      name: secret.name,
      value: secret.value,
      version: secret.version,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      description: secret.description,
      tags: secret.tags,
    };
  }

  async put(name: string, value: string, opts?: ParametersPutOptions): Promise<void> {
    if (!opts) return this.vault.put(name, value);
    return this.vault.put(name, value, { description: opts.description, tags: opts.tags });
  }

  async delete(name: string): Promise<void> {
    return this.vault.delete(name);
  }

  async list(): Promise<ParameterMetadata[]> {
    const secrets = await this.vault.list();
    return secrets.map((secret) => ({
      name: secret.name,
      version: secret.version,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      description: secret.description,
      tags: secret.tags,
    }));
  }

  async exists(name: string): Promise<boolean> {
    return this.vault.exists(name);
  }

  async getVersion(name: string, version: string): Promise<string> {
    return this.vault.getVersion(name, version);
  }

  async listVersions(name: string): Promise<ParameterVersionMetadata[]> {
    const versions = await this.vault.listVersions(name);
    return versions.map((v) => ({ version: v.version, status: v.status, createdAt: v.createdAt }));
  }

  supports(op: ParametersOperation): boolean {
    switch (op) {
      case 'get':
      case 'get_metadata':
      case 'exists':
        return this.vault.supports('get');
      case 'get_version':
        return this.vault.supports('get_version');
      case 'put':
        return this.vault.supports('put');
      case 'delete':
        return this.vault.supports('delete');
      case 'list':
        return this.vault.supports('list');
      case 'list_versions':
        return this.vault.supports('list_versions');
      default:
        return false;
    }
  }

  provider(): string {
    return 'oci';
  }
}
