import { validateConfig, type Config } from './config.js';
import {
  PROVIDER_AWS,
  PROVIDER_AZURE,
  PROVIDER_GCP,
  PROVIDER_OCI,
  type Provider,
} from './credentials/index.js';
import { FluidCloudError, ErrorCode } from './errors.js';
import {
  CloudServiceInitializer,
  getCapabilities,
  type ProviderCapabilities,
  type ProviderOptions,
} from './provider/initializer.js';
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
} from './provider/types/index.js';

/** Options passed to createClient alongside the config. */
export type ClientOptions = ProviderOptions;

function notInitialized(service: string, hint: string): FluidCloudError {
  return new FluidCloudError(`${service} not initialized - ${hint}`, ErrorCode.InvalidCredentials);
}

/**
 * The FluidCloud client. One instance is bound to one cloud entity, and exposes
 * every service that entity has enough configuration to reach.
 *
 * Services are constructed eagerly during createClient, exactly as the Go SDK
 * does. A service whose required options are missing is left unset; check the
 * matching has* flag before using it, or catch the error the getter throws.
 */
export class Client {
  private readonly initializer: CloudServiceInitializer;
  private readonly providerName: Provider;

  private readonly _storage?: Storage;
  private readonly _secrets?: Secrets;
  private readonly _parameters?: Parameters;
  private readonly _messaging?: Messaging;
  private readonly _queue?: Queue;
  private readonly _email?: Email;
  private readonly _monitoring?: Monitoring;
  private readonly _audit?: Audit;
  private readonly _streaming?: Streaming;
  private readonly _cdn?: Cdn;
  private readonly _identity?: Identity;
  private readonly _cache?: Cache;
  private readonly _search?: Search;

  /** @internal Use createClient. */
  constructor(init: {
    initializer: CloudServiceInitializer;
    provider: Provider;
    storage?: Storage;
    secrets?: Secrets;
    parameters?: Parameters;
    messaging?: Messaging;
    queue?: Queue;
    email?: Email;
    monitoring?: Monitoring;
    audit?: Audit;
    streaming?: Streaming;
    cdn?: Cdn;
    identity?: Identity;
    cache?: Cache;
    search?: Search;
  }) {
    this.initializer = init.initializer;
    this.providerName = init.provider;
    this._storage = init.storage;
    this._secrets = init.secrets;
    this._parameters = init.parameters;
    this._messaging = init.messaging;
    this._queue = init.queue;
    this._email = init.email;
    this._monitoring = init.monitoring;
    this._audit = init.audit;
    this._streaming = init.streaming;
    this._cdn = init.cdn;
    this._identity = init.identity;
    this._cache = init.cache;
    this._search = init.search;
  }

  /** The provider backing this entity. */
  get provider(): Provider {
    return this.providerName;
  }

  /** Coarse capability flags for the provider. */
  get capabilities(): ProviderCapabilities {
    return getCapabilities(this.providerName);
  }

  get storage(): Storage {
    if (!this._storage) throw notInitialized('storage', 'ensure storageAccount is provided for Azure');
    return this._storage;
  }
  get hasStorage(): boolean {
    return this._storage !== undefined;
  }

  get secrets(): Secrets {
    if (!this._secrets) throw notInitialized('secrets', 'ensure keyVaultName is provided for Azure, vaultOcid and compartment for OCI');
    return this._secrets;
  }
  get hasSecrets(): boolean {
    return this._secrets !== undefined;
  }

  get parameters(): Parameters {
    if (!this._parameters) throw notInitialized('parameters', 'ensure appConfigEndpoint is provided for Azure, vaultOcid and compartment for OCI');
    return this._parameters;
  }
  get hasParameters(): boolean {
    return this._parameters !== undefined;
  }

  get messaging(): Messaging {
    if (!this._messaging) throw notInitialized('messaging', 'ensure serviceBusNamespace is provided for Azure');
    return this._messaging;
  }
  get hasMessaging(): boolean {
    return this._messaging !== undefined;
  }

  get queue(): Queue {
    if (!this._queue) throw notInitialized('queue', 'ensure serviceBusNamespace is provided for Azure');
    return this._queue;
  }
  get hasQueue(): boolean {
    return this._queue !== undefined;
  }

  get email(): Email {
    if (!this._email) throw notInitialized('email', 'ensure acsEndpoint and acsKey are provided for Azure');
    return this._email;
  }
  get hasEmail(): boolean {
    return this._email !== undefined;
  }

  get monitoring(): Monitoring {
    if (!this._monitoring) throw notInitialized('monitoring', 'monitoring is unavailable for this entity');
    return this._monitoring;
  }
  get hasMonitoring(): boolean {
    return this._monitoring !== undefined;
  }

  get audit(): Audit {
    if (!this._audit) throw notInitialized('audit', 'audit is unavailable for this entity');
    return this._audit;
  }
  get hasAudit(): boolean {
    return this._audit !== undefined;
  }

  get streaming(): Streaming {
    if (!this._streaming) throw notInitialized('streaming', 'ensure eventHubsNamespace is provided for Azure');
    return this._streaming;
  }
  get hasStreaming(): boolean {
    return this._streaming !== undefined;
  }

  get cdn(): Cdn {
    if (!this._cdn) throw notInitialized('cdn', 'ensure cdnProfileName is provided for Azure');
    return this._cdn;
  }
  get hasCdn(): boolean {
    return this._cdn !== undefined;
  }

  get identity(): Identity {
    if (!this._identity) throw notInitialized('identity', 'ensure identityDomainEndpoint is provided for OCI');
    return this._identity;
  }
  get hasIdentity(): boolean {
    return this._identity !== undefined;
  }

  get cache(): Cache {
    if (!this._cache) throw notInitialized('cache', 'ensure redisEndpoint is provided');
    return this._cache;
  }
  get hasCache(): boolean {
    return this._cache !== undefined;
  }

  get search(): Search {
    if (!this._search) throw notInitialized('search', 'ensure searchEndpoint is provided, plus searchApiKey for Azure');
    return this._search;
  }
  get hasSearch(): boolean {
    return this._search !== undefined;
  }

  /** Releases client resources, including any Redis connection pool. */
  async close(): Promise<void> {
    if (this._cache) await this._cache.close();
    await this.initializer.close();
  }
}

/**
 * Creates a FluidCloud client. Credentials are fetched from the FluidCloud
 * server; there is no fallback to ambient cloud credentials.
 */
export async function createClient(cfg: Config, opts: ClientOptions = {}): Promise<Client> {
  const resolved = validateConfig(cfg);
  const options: ProviderOptions = { ...opts };
  if (!options.region && resolved.region) options.region = resolved.region;

  const initializer = new CloudServiceInitializer(resolved.serverUrl, resolved.apiKey);

  try {
    const provider = await initializer.getEntityProvider(resolved.entityId);
    const id = resolved.entityId;

    // A service is created only when the provider has everything it needs; the
    // gating below mirrors the Go SDK exactly.
    const storage = await maybe(
      provider === PROVIDER_AWS ||
        provider === PROVIDER_GCP ||
        (provider === PROVIDER_AZURE && !!options.storageAccount) ||
        (provider === PROVIDER_OCI && !!options.namespace),
      () => initializer.createStorage(id, options),
    );

    const secrets = await maybe(
      provider === PROVIDER_AWS ||
        provider === PROVIDER_GCP ||
        (provider === PROVIDER_AZURE && !!options.keyVaultName) ||
        (provider === PROVIDER_OCI && !!options.vaultOcid && !!options.compartment),
      () => initializer.createSecrets(id, options),
    );

    const parameters = await maybe(
      provider === PROVIDER_AWS ||
        provider === PROVIDER_GCP ||
        (provider === PROVIDER_AZURE && !!options.appConfigEndpoint) ||
        (provider === PROVIDER_OCI && !!options.vaultOcid && !!options.compartment),
      () => initializer.createParameters(id, options),
    );

    const messaging = await maybe(
      provider !== PROVIDER_AZURE || !!options.serviceBusNamespace,
      () => initializer.createMessaging(id, options),
    );

    const queue = await maybe(
      provider !== PROVIDER_AZURE || !!options.serviceBusNamespace,
      () => initializer.createQueue(id, options),
    );

    const email = await maybe(
      provider !== PROVIDER_AZURE || (!!options.acsEndpoint && !!options.acsKey),
      () => initializer.createEmail(id, options),
    );

    const monitoring = await maybe(true, () => initializer.createMonitoring(id, options));
    const audit = await maybe(true, () => initializer.createAudit(id, options));

    const streaming = await maybe(
      provider !== PROVIDER_AZURE || !!options.eventHubsNamespace,
      () => initializer.createStreaming(id, options),
    );

    const cdn = await maybe(
      provider !== PROVIDER_AZURE || !!options.cdnProfileName,
      () => initializer.createCdn(id, options),
    );

    const identity = await maybe(
      provider !== PROVIDER_OCI || !!options.identityDomainEndpoint,
      () => initializer.createIdentity(id, options),
    );

    const cache = await maybe(!!options.redisEndpoint, () => initializer.createCache(id, options));

    const search = await maybe(
      !!options.searchEndpoint &&
        provider !== PROVIDER_GCP &&
        (provider !== PROVIDER_AZURE || !!options.searchApiKey),
      () => initializer.createSearch(id, options),
    );

    return new Client({
      initializer,
      provider,
      storage,
      secrets,
      parameters,
      messaging,
      queue,
      email,
      monitoring,
      audit,
      streaming,
      cdn,
      identity,
      cache,
      search,
    });
  } catch (err) {
    await initializer.close();
    throw err;
  }
}

async function maybe<T>(enabled: boolean, create: () => Promise<T>): Promise<T | undefined> {
  return enabled ? create() : undefined;
}
