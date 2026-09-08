import * as ociSecrets from 'oci-secrets';
import * as ociVault from 'oci-vault';

import type { OciCredentials } from '../../credentials/index.js';
import { NotFoundError, ValidationError, wrapProviderError } from '../../errors.js';
import type {
  Secret,
  SecretMetadata,
  Secrets,
  SecretsOperation,
  SecretsPutOptions,
  SecretVersionMetadata,
} from '../types/secrets.js';
import { ociAuthProvider } from './auth.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseVersionNumber(version: string): number {
  const n = Number.parseInt(version, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** OCI Vault implementation of the unified Secrets interface. */
export class VaultSecrets implements Secrets {
  private readonly secretsClient: ociSecrets.SecretsClient;
  private readonly vaultsClient: ociVault.VaultsClient;
  private readonly vaultOcid: string;
  private readonly compartment: string;
  private readonly keyOcid?: string;

  constructor(creds: OciCredentials, vaultOcid: string, compartment: string, keyOcid?: string) {
    const provider = ociAuthProvider(creds);
    this.secretsClient = new ociSecrets.SecretsClient({ authenticationDetailsProvider: provider });
    this.vaultsClient = new ociVault.VaultsClient({ authenticationDetailsProvider: provider });
    this.vaultOcid = vaultOcid;
    this.compartment = compartment;
    this.keyOcid = keyOcid;
  }

  private async getSecretOcidByName(name: string): Promise<string> {
    let resp: ociVault.responses.ListSecretsResponse;
    try {
      resp = await this.vaultsClient.listSecrets({
        compartmentId: this.compartment,
        vaultId: this.vaultOcid,
        name,
      });
    } catch (err) {
      wrapProviderError('oci', 'ListSecrets', err);
    }

    const item = resp.items[0];
    if (!item?.id) throw new NotFoundError(`secret ${name} not found`);
    return item.id;
  }

  private requireKeyOcid(): string {
    if (!this.keyOcid) {
      throw new ValidationError('keyOcid', 'is required to create a secret in OCI Vault');
    }
    return this.keyOcid;
  }

  private async waitForSecretState(secretOcid: string, desired: ociVault.models.Secret.LifecycleState): Promise<void> {
    for (let i = 0; i < 30; i++) {
      let resp: ociVault.responses.GetSecretResponse;
      try {
        resp = await this.vaultsClient.getSecret({ secretId: secretOcid });
      } catch (err) {
        wrapProviderError('oci', 'WaitForSecretState', err);
      }
      if (resp.secret.lifecycleState === desired) return;
      await sleep(1000);
    }
    wrapProviderError(
      'oci',
      'WaitForSecretState',
      new Error(`secret ${secretOcid} did not reach state ${desired} within 30s`),
    );
  }

  async get(name: string): Promise<string> {
    try {
      const resp = await this.secretsClient.getSecretBundleByName({
        secretName: name,
        vaultId: this.vaultOcid,
      });
      const content = resp.secretBundle.secretBundleContent;
      if (content?.content === undefined) throw new NotFoundError(`secret ${name} not found`);
      return Buffer.from(content.content, 'base64').toString('utf-8');
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      wrapProviderError('oci', 'GetSecretBundle', err);
    }
  }

  async getWithMetadata(name: string): Promise<Secret> {
    const secretOcid = await this.getSecretOcidByName(name);

    let secretResp: ociVault.responses.GetSecretResponse;
    try {
      secretResp = await this.vaultsClient.getSecret({ secretId: secretOcid });
    } catch (err) {
      wrapProviderError('oci', 'GetSecret', err);
    }

    let bundleResp: ociSecrets.responses.GetSecretBundleResponse;
    try {
      bundleResp = await this.secretsClient.getSecretBundle({ secretId: secretOcid });
    } catch (err) {
      wrapProviderError('oci', 'GetSecretBundle', err);
    }

    const content = bundleResp.secretBundle.secretBundleContent;
    return {
      name,
      value: content?.content !== undefined ? Buffer.from(content.content, 'base64').toString('utf-8') : '',
      version: secretResp.secret.id,
      createdAt: secretResp.secret.timeCreated,
      updatedAt: new Date(0),
      description: secretResp.secret.description ?? '',
      tags: {},
    };
  }

  private async putBytes(name: string, data: Buffer, opts?: SecretsPutOptions): Promise<void> {
    let existingOcid: string | undefined;
    try {
      existingOcid = await this.getSecretOcidByName(name);
    } catch {
      existingOcid = undefined;
    }

    const encoded = data.toString('base64');

    if (existingOcid) {
      try {
        await this.vaultsClient.updateSecret({
          secretId: existingOcid,
          updateSecretDetails: {
            secretContent: { contentType: 'BASE64', content: encoded },
          },
        });
      } catch (err) {
        wrapProviderError('oci', 'UpdateSecret', err);
      }
      await this.waitForSecretState(existingOcid, ociVault.models.Secret.LifecycleState.Active);
      return;
    }

    let resp: ociVault.responses.CreateSecretResponse;
    try {
      resp = await this.vaultsClient.createSecret({
        createSecretDetails: {
          compartmentId: this.compartment,
          secretName: name,
          vaultId: this.vaultOcid,
          secretContent: { contentType: 'BASE64', content: encoded },
          keyId: this.requireKeyOcid(),
          description: opts?.description || undefined,
        },
      });
    } catch (err) {
      wrapProviderError('oci', 'CreateSecret', err);
    }

    await this.waitForSecretState(resp.secret.id, ociVault.models.Secret.LifecycleState.Active);
  }

  async put(name: string, value: string, opts?: SecretsPutOptions): Promise<void> {
    await this.putBytes(name, Buffer.from(value, 'utf-8'), opts);
  }

  async delete(name: string): Promise<void> {
    const secretOcid = await this.getSecretOcidByName(name);
    try {
      await this.vaultsClient.scheduleSecretDeletion({
        secretId: secretOcid,
        scheduleSecretDeletionDetails: {},
      });
    } catch (err) {
      wrapProviderError('oci', 'ScheduleSecretDeletion', err);
    }
    await this.waitForSecretState(secretOcid, ociVault.models.Secret.LifecycleState.PendingDeletion);
  }

  async list(): Promise<SecretMetadata[]> {
    try {
      const resp = await this.vaultsClient.listSecrets({
        compartmentId: this.compartment,
        vaultId: this.vaultOcid,
      });
      return resp.items.map((secret) => ({
        name: secret.secretName,
        version: secret.id,
        createdAt: secret.timeCreated,
        updatedAt: new Date(0),
        description: secret.description ?? '',
        tags: {},
      }));
    } catch (err) {
      wrapProviderError('oci', 'ListSecrets', err);
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.getSecretOcidByName(name);
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(name: string, version: string): Promise<string> {
    try {
      const resp = await this.secretsClient.getSecretBundleByName({
        secretName: name,
        vaultId: this.vaultOcid,
        versionNumber: parseVersionNumber(version),
      });
      const content = resp.secretBundle.secretBundleContent;
      if (content?.content === undefined) throw new NotFoundError(`secret ${name} version ${version} not found`);
      return Buffer.from(content.content, 'base64').toString('utf-8');
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      wrapProviderError('oci', 'GetSecretBundle(Version)', err);
    }
  }

  async listVersions(name: string): Promise<SecretVersionMetadata[]> {
    const secretOcid = await this.getSecretOcidByName(name);
    try {
      const resp = await this.secretsClient.listSecretBundleVersions({ secretId: secretOcid });
      return resp.items.map((item) => {
        let status = 'unknown';
        for (const stage of item.stages ?? []) {
          if (stage === ociSecrets.models.SecretBundleVersionSummary.Stages.Current) {
            status = 'current';
            break;
          } else if (stage === ociSecrets.models.SecretBundleVersionSummary.Stages.Previous) {
            status = 'previous';
          } else if (stage === ociSecrets.models.SecretBundleVersionSummary.Stages.Deprecated) {
            status = 'deprecated';
          }
        }
        return {
          version: String(item.versionNumber),
          status,
          createdAt: item.timeCreated ?? new Date(0),
        };
      });
    } catch (err) {
      wrapProviderError('oci', 'ListSecretBundleVersions', err);
    }
  }

  async putBinary(name: string, data: Buffer | Uint8Array, opts?: SecretsPutOptions): Promise<void> {
    await this.putBytes(name, Buffer.isBuffer(data) ? data : Buffer.from(data), opts);
  }

  async getBinary(name: string): Promise<Buffer> {
    try {
      const resp = await this.secretsClient.getSecretBundleByName({
        secretName: name,
        vaultId: this.vaultOcid,
      });
      const content = resp.secretBundle.secretBundleContent;
      if (content?.content === undefined) throw new NotFoundError(`secret ${name} not found`);
      return Buffer.from(content.content, 'base64');
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      wrapProviderError('oci', 'GetSecretBundle(Binary)', err);
    }
  }

  async restore(name: string): Promise<void> {
    const secretOcid = await this.getSecretOcidByName(name);
    try {
      await this.vaultsClient.cancelSecretDeletion({ secretId: secretOcid });
    } catch (err) {
      wrapProviderError('oci', 'CancelSecretDeletion', err);
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
    return 'oci';
  }
}
