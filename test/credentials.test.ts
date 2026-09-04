import { afterEach, describe, expect, it, vi } from 'vitest';

import { CloudEntity, Fetcher } from '../src/credentials/index.js';
import { encryptEnvelope } from '../src/credentials/envelope.js';
import { AccessDeniedError, EntityNotFoundError, ProviderError } from '../src/errors.js';

function entity(provider: string, credentials: Record<string, unknown>, region = 'us-east-1'): CloudEntity {
  return new CloudEntity({ entityId: 'e-1', provider: provider as never, region, credentials });
}

describe('CloudEntity credential extraction', () => {
  it('reads static AWS access keys', () => {
    const creds = entity('aws', { accessKey: 'AKIA', secretAccessKey: 'shh', sessionToken: 'tok' }).getAwsCredentials();
    expect(creds).toMatchObject({ accessKey: 'AKIA', secretAccessKey: 'shh', sessionToken: 'tok', region: 'us-east-1' });
  });

  it('reads an AWS assume-role entity without access keys', () => {
    const creds = entity('aws', {
      authMode: 'assume_role',
      roleArn: 'arn:aws:iam::1:role/r',
      externalId: 'x',
    }).getAwsCredentials();
    expect(creds).toMatchObject({ authMode: 'assume_role', roleArn: 'arn:aws:iam::1:role/r', externalId: 'x' });
    expect(creds.accessKey).toBe('');
  });

  it.each([
    ['aws missing secret', 'aws', { accessKey: 'AKIA' }, (e: CloudEntity) => e.getAwsCredentials()],
    ['aws assume-role missing arn', 'aws', { authMode: 'assume_role' }, (e: CloudEntity) => e.getAwsCredentials()],
    ['azure missing clientSecret', 'azure', { tenantId: 't', clientId: 'c', subscriptionId: 's' }, (e: CloudEntity) => e.getAzureCredentials()],
    ['oci missing privateKey', 'oci', { tenancyOcid: 't', userOcid: 'u', fingerprint: 'f' }, (e: CloudEntity) => e.getOciCredentials()],
    ['gcp missing serviceAccountJson', 'gcp', { projectId: 'p' }, (e: CloudEntity) => e.getGcpCredentials()],
  ])('rejects %s', (_name, provider, credentials, extract) => {
    expect(() => extract(entity(provider, credentials))).toThrow(ProviderError);
  });

  it.each([
    ['azure', (e: CloudEntity) => e.getAwsCredentials()],
    ['aws', (e: CloudEntity) => e.getAzureCredentials()],
    ['gcp', (e: CloudEntity) => e.getOciCredentials()],
    ['oci', (e: CloudEntity) => e.getGcpCredentials()],
  ])('refuses to read the wrong provider credentials from %s', (provider, extract) => {
    expect(() => extract(entity(provider, {}))).toThrow(ProviderError);
  });

  it('falls back to the entity region for GCP location and prefers an explicit one', () => {
    expect(entity('gcp', { projectId: 'p', serviceAccountJson: '{}' }, 'europe-west1').getGcpCredentials().location).toBe('europe-west1');
    expect(
      entity('gcp', { projectId: 'p', serviceAccountJson: '{}', location: 'asia-south1' }, 'europe-west1').getGcpCredentials().location,
    ).toBe('asia-south1');
  });
});

describe('Fetcher', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects construction without a URL or token', () => {
    expect(() => new Fetcher('', 'tok')).toThrow();
    expect(() => new Fetcher('https://fc', '')).toThrow();
  });

  it('sends the ephemeral public key and decrypts the response envelope', async () => {
    const payload = { accessKey: 'AKIA', secretAccessKey: 'shh' };
    let seenHeaderKey = '';
    let seenUrl = '';

    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenHeaderKey = (init.headers as Record<string, string>)['X-API-Key'];
      const { publicKey } = JSON.parse(init.body as string) as { publicKey: string };
      const sealed = encryptEnvelope(publicKey, payload);
      return new Response(JSON.stringify({ provider: 'AWS', region: 'us-east-1', ...sealed }), { status: 200 });
    });

    const entityOut = await new Fetcher('https://fc.internal/', 'fc_k_s').getCloudEntitySecure('e-9');

    expect(seenUrl).toBe('https://fc.internal/api/v1/cloudaccounts/e-9/secure-credentials');
    expect(seenHeaderKey).toBe('fc_k_s');
    expect(entityOut.provider).toBe('aws');
    expect(entityOut.credentials).toEqual(payload);
  });

  it.each([
    [404, EntityNotFoundError],
    [401, AccessDeniedError],
    [403, AccessDeniedError],
    [500, ProviderError],
  ])('maps HTTP %i to the right error', async (status, expected) => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status }));
    await expect(new Fetcher('https://fc', 'tok').getCloudEntitySecure('e-1')).rejects.toBeInstanceOf(expected);
  });

  it('wraps a transport failure as a ProviderError', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(new Fetcher('https://fc', 'tok').getCloudEntitySecure('e-1')).rejects.toBeInstanceOf(ProviderError);
  });
});
