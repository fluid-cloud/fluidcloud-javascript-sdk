import { ValidationError } from './errors.js';

/** Default FluidCloud server URL used when serverUrl is not provided. */
export const DEFAULT_SERVER_URL = 'https://app.fluidcloud.com';

/** Configuration for the FluidCloud wrapper client. */
export interface Config {
  /** API server URL. Defaults to https://app.fluidcloud.com. */
  serverUrl?: string;
  /** FluidCloud API key, format "fc_<keyid>_<secret>". Required. */
  apiKey: string;
  /** Cloud entity ID whose credentials and provider are used. Required. */
  entityId: string;
  /** Optional override for the cloud region. */
  region?: string;
}

/** Config with defaults applied. */
export interface ResolvedConfig extends Config {
  serverUrl: string;
}

/** Validates the configuration and returns it with defaults applied. */
export function validateConfig(cfg: Config): ResolvedConfig {
  const serverUrl = cfg.serverUrl && cfg.serverUrl !== '' ? cfg.serverUrl : DEFAULT_SERVER_URL;
  if (!cfg.apiKey) throw new ValidationError('apiKey', 'is required');
  if (!cfg.entityId) throw new ValidationError('entityId', 'is required');
  return { ...cfg, serverUrl };
}
