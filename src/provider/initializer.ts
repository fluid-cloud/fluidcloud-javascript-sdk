import {
  type CloudEntity,
  Fetcher,
  PROVIDER_AWS,
  PROVIDER_AZURE,
  PROVIDER_GCP,
  PROVIDER_OCI,
  type Provider,
} from '../credentials/index.js';
import { InvalidCredentialsError, ProviderNotFoundError } from '../errors.js';
import type {
  Audit,
  Cache,
  Cdn,
  Email,
  Identity,
  Messaging,
  Monitoring,
  Parameters,
  Queue,
  Search,
  Secrets,
  Storage,
  Streaming,
} from './types/index.js';

/**
 * Provider implementations load on demand, so an application that only talks to
 * one cloud never resolves the other three cloud SDKs. Each module is imported
 * at most once and the promise is reused.
 */
let awsModule: Promise<typeof import('./aws/index.js')> | undefined;
let azureModule: Promise<typeof import('./azure/index.js')> | undefined;
let gcpModule: Promise<typeof import('./gcp/index.js')> | undefined;
let ociModule: Promise<typeof import('./oci/index.js')> | undefined;

const loadAws = () => (awsModule ??= import('./aws/index.js'));
const loadAzure = () => (azureModule ??= import('./azure/index.js'));
const loadGcp = () => (gcpModule ??= import('./gcp/index.js'));
const loadOci = () => (ociModule ??= import('./oci/index.js'));

/** Provider-specific options needed to reach services the entity does not describe. */
export interface ProviderOptions {
  /** Region override, used by AWS and OCI. */
  region?: string;

  // --- Azure ---
  /** Required for Azure Blob Storage. */
  storageAccount?: string;
  /** Access key for Azure Blob Storage, the alternative to service-principal auth. */
  storageAccountKey?: string;
  /** Required for Azure Key Vault. */
  keyVaultName?: string;
  /** Azure App Configuration endpoint, https://<name>.azconfig.io. */
  appConfigEndpoint?: string;
  /** Azure Service Bus namespace, for messaging and queue. */
  serviceBusNamespace?: string;
  /** Azure Communication Services endpoint, for email. */
  acsEndpoint?: string;
  /** Azure Communication Services access key, for email. */
  acsKey?: string;
  /** Azure Log Analytics workspace ID, for monitoring queries. */
  logAnalyticsWorkspaceId?: string;
  /** Azure Data Collection Endpoint, for metric and log ingestion. */
  dataCollectionEndpoint?: string;
  /** Azure resource group, for monitoring and log group operations. */
  resourceGroup?: string;

  // --- OCI ---
  /** Required for OCI Object Storage. */
  namespace?: string;
  /** Required for OCI Vault operations. */
  compartment?: string;
  /** Required for OCI Vault operations. */
  vaultOcid?: string;
  /** Master encryption key OCID, required to create OCI Vault secrets. */
  keyOcid?: string;
  /** OCI compartment for Queue; falls back to compartment. */
  ociQueueCompartment?: string;
  /** OCI compartment for Email; falls back to compartment. */
  ociEmailCompartment?: string;

  // --- Streaming ---
  /** Comma-separated Kafka brokers for AWS MSK. Empty selects Kinesis. */
  mskBootstrapServers?: string;
  /** Azure Event Hubs namespace. */
  eventHubsNamespace?: string;

  // --- CDN ---
  /** Azure Front Door profile name, required for Azure CDN. */
  cdnProfileName?: string;

  // --- Identity ---
  /** OCI IAM Identity Domain base URL, required for OCI identity. */
  identityDomainEndpoint?: string;

  // --- Cache ---
  /** Managed Redis endpoint "host:port", required for cache. */
  redisEndpoint?: string;
  /** Redis AUTH password or access key. */
  redisPassword?: string;
  /** Enables TLS. Azure Cache for Redis requires it. */
  redisTls?: boolean;
  /** Redis logical database number. Defaults to 0. */
  redisDb?: number;

  // --- Search ---
  /** OpenSearch / AI Search endpoint URL, required for search. */
  searchEndpoint?: string;
  /** Basic-auth username for OCI OpenSearch. */
  searchUsername?: string;
  /** Basic-auth password for OCI OpenSearch. */
  searchPassword?: string;
  /** Azure AI Search admin API key. */
  searchApiKey?: string;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new InvalidCredentialsError(message);
  return value;
}

/**
 * Builds provider service clients from credentials fetched from FluidCloud.
 *
 * The entity is fetched once and reused for the lifetime of the initializer. The
 * Go SDK re-fetches per service, which costs one HTTPS round trip and one RSA
 * keygen per service; the credentials are identical either way.
 */
export class CloudServiceInitializer {
  private readonly credentialFetcher: Fetcher;
  private entity?: CloudEntity;

  constructor(serverUrl: string, apiKey: string) {
    this.credentialFetcher = new Fetcher(serverUrl, apiKey);
  }

  /** Releases initializer resources. */
  async close(): Promise<void> {
    await this.credentialFetcher.close();
  }

  /** Fetches the entity, reusing the cached copy after the first call. */
  private async getEntity(entityId: string): Promise<CloudEntity> {
    if (!this.entity) this.entity = await this.credentialFetcher.getCloudEntitySecure(entityId);
    return this.entity;
  }

  /** Returns the provider backing the entity. */
  async getEntityProvider(entityId: string): Promise<Provider> {
    return (await this.getEntity(entityId)).provider;
  }

  /** Creates the storage client for the entity provider. */
  async createStorage(entityId: string, opts: ProviderOptions): Promise<Storage> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).S3Storage(entity.getAwsCredentials(), opts.region);
      case PROVIDER_AZURE: {
        const account = required(opts.storageAccount, 'storage account name is required for Azure');
        const creds = entity.getAzureCredentials();
        // Storage account keys are storage-account specific, so they arrive via
        // options rather than the server credential envelope.
        if (opts.storageAccountKey) {
          creds.storageAccountName = account;
          creds.storageAccountKey = opts.storageAccountKey;
        }
        return new (await loadAzure()).BlobStorage(creds, account);
      }
      case PROVIDER_OCI:
        return new (await loadOci()).ObjectStorage(
          entity.getOciCredentials(),
          required(opts.namespace, 'namespace is required for OCI'),
          opts.compartment,
        );
      case PROVIDER_GCP:
        return new (await loadGcp()).GcsStorage(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the secrets client for the entity provider. */
  async createSecrets(entityId: string, opts: ProviderOptions): Promise<Secrets> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).SecretsManager(entity.getAwsCredentials());
      case PROVIDER_AZURE:
        return new (await loadAzure()).KeyVaultSecrets(
          entity.getAzureCredentials(),
          required(opts.keyVaultName, 'key vault name is required for Azure'),
        );
      case PROVIDER_OCI:
        return new (await loadOci()).VaultSecrets(
          entity.getOciCredentials(),
          required(opts.vaultOcid, 'vault OCID is required for OCI'),
          required(opts.compartment, 'compartment is required for OCI'),
          opts.keyOcid,
        );
      case PROVIDER_GCP:
        return new (await loadGcp()).SecretManagerSecrets(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the parameters client for the entity provider. */
  async createParameters(entityId: string, opts: ProviderOptions): Promise<Parameters> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).ParameterStore(entity.getAwsCredentials());
      case PROVIDER_AZURE:
        return new (await loadAzure()).AppConfigurationParameters(
          entity.getAzureCredentials(),
          required(opts.appConfigEndpoint, 'app configuration endpoint is required for Azure'),
        );
      case PROVIDER_OCI: {
        // OCI has no parameter store, so parameters are served from Vault secrets.
        const vault = new (await loadOci()).VaultSecrets(
          entity.getOciCredentials(),
          required(opts.vaultOcid, 'vault OCID is required for OCI'),
          required(opts.compartment, 'compartment is required for OCI'),
          opts.keyOcid,
        );
        return new (await loadOci()).VaultParameters(vault);
      }
      case PROVIDER_GCP:
        return new (await loadGcp()).ParameterManagerParameters(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the messaging client for the entity provider. */
  async createMessaging(entityId: string, opts: ProviderOptions): Promise<Messaging> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).SnsMessaging(entity.getAwsCredentials());
      case PROVIDER_AZURE:
        return new (await loadAzure()).ServiceBusMessaging(
          entity.getAzureCredentials(),
          required(opts.serviceBusNamespace, 'service bus namespace is required for Azure'),
        );
      case PROVIDER_OCI: {
        const creds = entity.getOciCredentials();
        return new (await loadOci()).OnsMessaging(creds, opts.compartment ?? creds.compartmentOcid ?? '');
      }
      case PROVIDER_GCP:
        return new (await loadGcp()).PubSubMessaging(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the queue client for the entity provider. */
  async createQueue(entityId: string, opts: ProviderOptions): Promise<Queue> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).SqsQueue(entity.getAwsCredentials());
      case PROVIDER_AZURE:
        return new (await loadAzure()).ServiceBusQueue(
          entity.getAzureCredentials(),
          required(opts.serviceBusNamespace, 'service bus namespace is required for Azure'),
        );
      case PROVIDER_OCI: {
        const creds = entity.getOciCredentials();
        const compartment = opts.ociQueueCompartment ?? opts.compartment ?? creds.compartmentOcid ?? '';
        return new (await loadOci()).OciQueue(creds, compartment);
      }
      case PROVIDER_GCP:
        return new (await loadGcp()).PubSubQueue(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the email client for the entity provider. */
  async createEmail(entityId: string, opts: ProviderOptions): Promise<Email> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).SesEmail(entity.getAwsCredentials());
      case PROVIDER_AZURE:
        return new (await loadAzure()).AcsEmail(
          required(opts.acsEndpoint, 'ACS endpoint is required for Azure'),
          required(opts.acsKey, 'ACS key is required for Azure'),
        );
      case PROVIDER_OCI: {
        const creds = entity.getOciCredentials();
        const compartment = opts.ociEmailCompartment ?? opts.compartment ?? creds.compartmentOcid ?? '';
        return new (await loadOci()).OciEmail(creds, compartment);
      }
      case PROVIDER_GCP:
        return new (await loadGcp()).GcpEmail();
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the monitoring client for the entity provider. */
  async createMonitoring(entityId: string, opts: ProviderOptions): Promise<Monitoring> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).CloudWatchMonitoring(entity.getAwsCredentials());
      case PROVIDER_AZURE:
        return new (await loadAzure()).AzureMonitoring(
          entity.getAzureCredentials(),
          opts.resourceGroup ?? '',
          opts.logAnalyticsWorkspaceId ?? '',
          opts.dataCollectionEndpoint ?? '',
        );
      case PROVIDER_OCI: {
        const creds = entity.getOciCredentials();
        return new (await loadOci()).OciMonitoring(creds, opts.compartment ?? creds.compartmentOcid ?? '');
      }
      case PROVIDER_GCP:
        return new (await loadGcp()).CloudMonitoring(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the audit client for the entity provider. */
  async createAudit(entityId: string, opts: ProviderOptions): Promise<Audit> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).CloudTrailAudit(entity.getAwsCredentials());
      case PROVIDER_AZURE:
        return new (await loadAzure()).ActivityLogAudit(entity.getAzureCredentials());
      case PROVIDER_OCI: {
        const creds = entity.getOciCredentials();
        return new (await loadOci()).OciAudit(creds, opts.compartment ?? creds.compartmentOcid ?? '');
      }
      case PROVIDER_GCP:
        return new (await loadGcp()).CloudAudit(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the streaming client for the entity provider. */
  async createStreaming(entityId: string, opts: ProviderOptions): Promise<Streaming> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS: {
        const creds = entity.getAwsCredentials();
        // Kinesis is the default; MSK is selected by supplying bootstrap servers.
        if (opts.mskBootstrapServers) return new (await loadAws()).MskStreaming(creds, opts.mskBootstrapServers);
        return new (await loadAws()).KinesisStreaming(creds, opts.region);
      }
      case PROVIDER_AZURE:
        return new (await loadAzure()).EventHubsStreaming(
          entity.getAzureCredentials(),
          opts.resourceGroup ?? '',
          required(opts.eventHubsNamespace, 'event hubs namespace is required for Azure'),
        );
      case PROVIDER_OCI: {
        const creds = entity.getOciCredentials();
        return new (await loadOci()).OciStreaming(creds, opts.compartment ?? creds.compartmentOcid ?? '');
      }
      case PROVIDER_GCP:
        return new (await loadGcp()).PubSubStreaming(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the CDN client for the entity provider. */
  async createCdn(entityId: string, opts: ProviderOptions): Promise<Cdn> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).CloudFrontCdn(entity.getAwsCredentials(), opts.region);
      case PROVIDER_AZURE:
        return new (await loadAzure()).FrontDoorCdn(
          entity.getAzureCredentials(),
          opts.resourceGroup ?? '',
          required(opts.cdnProfileName, 'CDN profile name is required for Azure'),
        );
      case PROVIDER_OCI:
        // OCI has no native CDN; every operation throws UnsupportedError.
        return new (await loadOci()).OciCdn();
      case PROVIDER_GCP:
        return new (await loadGcp()).CloudCdn(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the identity client for the entity provider. */
  async createIdentity(entityId: string, opts: ProviderOptions): Promise<Identity> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).CognitoIdentity(entity.getAwsCredentials(), opts.region);
      case PROVIDER_AZURE:
        return new (await loadAzure()).EntraIdentity(entity.getAzureCredentials());
      case PROVIDER_OCI:
        return new (await loadOci()).IamDomainsIdentity(
          entity.getOciCredentials(),
          required(opts.identityDomainEndpoint, 'identity domain endpoint is required for OCI'),
        );
      case PROVIDER_GCP:
        return new (await loadGcp()).CloudIdentity(entity.getGcpCredentials());
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the cache client. Every provider speaks the Redis wire protocol. */
  async createCache(entityId: string, opts: ProviderOptions): Promise<Cache> {
    const entity = await this.getEntity(entityId);
    const endpoint = required(opts.redisEndpoint, 'redis endpoint is required for cache');
    const password = opts.redisPassword ?? '';
    const db = opts.redisDb ?? 0;
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).ElastiCacheRedis(endpoint, password, opts.redisTls ?? false, db);
      case PROVIDER_AZURE:
        return new (await loadAzure()).AzureRedisCache(endpoint, password, db);
      case PROVIDER_OCI:
        return new (await loadOci()).OciRedisCache(endpoint, password, opts.redisTls ?? false, db);
      case PROVIDER_GCP:
        return new (await loadGcp()).MemorystoreRedis(endpoint, password, opts.redisTls ?? false, db);
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }

  /** Creates the search client for the entity provider. */
  async createSearch(entityId: string, opts: ProviderOptions): Promise<Search> {
    const entity = await this.getEntity(entityId);
    switch (entity.provider) {
      case PROVIDER_AWS:
        return new (await loadAws()).OpenSearchAws(
          entity.getAwsCredentials(),
          required(opts.searchEndpoint, 'search endpoint is required'),
          opts.region,
        );
      case PROVIDER_AZURE:
        return new (await loadAzure()).AiSearch(
          required(opts.searchEndpoint, 'search endpoint is required'),
          required(opts.searchApiKey, 'search API key is required for Azure'),
        );
      case PROVIDER_OCI:
        return new (await loadOci()).OpenSearchOci(
          required(opts.searchEndpoint, 'search endpoint is required'),
          opts.searchUsername ?? '',
          opts.searchPassword ?? '',
        );
      case PROVIDER_GCP:
        return new (await loadGcp()).GcpSearch();
      default:
        throw new ProviderNotFoundError(`provider ${entity.provider}: provider not found`);
    }
  }
}

/** Coarse capability flags for a provider. */
export interface ProviderCapabilities {
  provider: string;
  storageGet: boolean;
  storagePut: boolean;
  storageDelete: boolean;
  storageList: boolean;
  secretsGet: boolean;
  secretsPut: boolean;
  secretsDelete: boolean;
  secretsList: boolean;
  parametersGet: boolean;
  parametersPut: boolean;
  parametersDelete: boolean;
  parametersList: boolean;
}

/** Returns the capabilities for a provider. */
export function getCapabilities(provider: Provider | string): ProviderCapabilities {
  const known =
    provider === PROVIDER_AWS || provider === PROVIDER_AZURE || provider === PROVIDER_GCP || provider === PROVIDER_OCI;
  return {
    provider: String(provider),
    storageGet: known,
    storagePut: known,
    storageDelete: known,
    storageList: known,
    secretsGet: known,
    secretsPut: known,
    secretsDelete: known,
    secretsList: known,
    parametersGet: known,
    parametersPut: known,
    parametersDelete: known,
    parametersList: known,
  };
}
