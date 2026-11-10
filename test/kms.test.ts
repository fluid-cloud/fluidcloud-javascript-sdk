import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AwsCredentials, AzureCredentials, GcpCredentials, OciCredentials } from '../src/credentials/index.js';
import { InvalidCredentialsError, ProviderError, ValidationError } from '../src/errors.js';
import type { Kms, KmsOperation } from '../src/provider/types/kms.js';

const awsSendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-kms', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-kms')>('@aws-sdk/client-kms');
  return {
    ...actual,
    KMSClient: vi.fn().mockImplementation(function KMSClient() {
      return { send: awsSendMock };
    }),
  };
});

const azureMocks = vi.hoisted(() => ({
  getKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  cryptoKeyIds: [] as string[],
}));

vi.mock('@azure/keyvault-keys', () => ({
  KeyClient: vi.fn().mockImplementation(function KeyClient() {
    return { getKey: azureMocks.getKey };
  }),
  CryptographyClient: vi.fn().mockImplementation(function CryptographyClient(kid: string) {
    azureMocks.cryptoKeyIds.push(kid);
    return { keyID: kid, encrypt: azureMocks.encrypt, decrypt: azureMocks.decrypt };
  }),
}));

const gcpMocks = vi.hoisted(() => ({ encrypt: vi.fn(), decrypt: vi.fn(), close: vi.fn() }));

vi.mock('@google-cloud/kms', async () => {
  const actual = await vi.importActual<typeof import('@google-cloud/kms')>('@google-cloud/kms');
  return {
    ...actual,
    KeyManagementServiceClient: vi.fn().mockImplementation(function KeyManagementServiceClient() {
      return gcpMocks;
    }),
  };
});

const ociMocks = vi.hoisted(() => ({
  crypto: { encrypt: vi.fn(), decrypt: vi.fn(), generateDataEncryptionKey: vi.fn(), endpoint: '' },
  vault: { getVault: vi.fn() },
}));

vi.mock('oci-keymanagement', async () => {
  const actual = await vi.importActual<typeof import('oci-keymanagement')>('oci-keymanagement');
  return {
    ...actual,
    KmsCryptoClient: vi.fn().mockImplementation(function KmsCryptoClient() {
      return ociMocks.crypto;
    }),
    KmsVaultClient: vi.fn().mockImplementation(function KmsVaultClient() {
      return ociMocks.vault;
    }),
  };
});

const { AwsKms } = await import('../src/provider/aws/kms.js');
const { KeyVaultKms, vaultBaseUrl } = await import('../src/provider/azure/kms.js');
const { CloudKms } = await import('../src/provider/gcp/kms.js');
const { VaultKms, resolveCryptoEndpoint } = await import('../src/provider/oci/kms.js');
const { canonicalContext, crc32c, kmsContext, MAX_DATA_KEY_BYTES, supportsKmsOperation } = await import(
  '../src/provider/shared/kms.js'
);
const awsCommands = await import('@aws-sdk/client-kms');

const awsCreds: AwsCredentials = { accessKey: 'AKIA', secretAccessKey: 'shh', region: 'us-east-1' };
const azureCreds: AzureCredentials = { tenantId: 't', clientId: 'c', clientSecret: 's', subscriptionId: 'sub' };
const gcpCreds: GcpCredentials = {
  projectId: 'proj',
  serviceAccountJson: JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: 'k' }),
};
const ociCreds: OciCredentials = {
  tenancyOcid: 'ocid1.tenancy.oc1..a',
  userOcid: 'ocid1.user.oc1..a',
  fingerprint: 'aa:bb:cc',
  privateKey: 'fake-key',
  region: 'us-ashburn-1',
};

const ctx = { tenant: 'acme', purpose: 'db' };
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();
const u32 = (n: number) => Buffer.from([0, 0, 0, n]);
const ascii = (s: string) => Buffer.from(s, 'utf8');

beforeEach(() => {
  vi.clearAllMocks();
  azureMocks.cryptoKeyIds.length = 0;
});

describe('canonicalContext', () => {
  it.each([
    ['undefined options', undefined],
    ['no context', {}],
    ['empty context', { encryptionContext: {} }],
  ])('encodes %s as an empty buffer', (_name, opts) => {
    expect(canonicalContext(opts).length).toBe(0);
    expect(kmsContext(opts)).toBeUndefined();
  });

  // Byte layout shared with kmsutil.Canonical in the Go SDK and the Python SDK:
  // keys sorted by bytes, each key and value prefixed with a big-endian uint32 length.
  it.each([
    ['single pair', { a: '1' }, Buffer.concat([u32(1), ascii('a'), u32(1), ascii('1')])],
    [
      'keys sorted regardless of insertion order',
      { b: '22', a: '1' },
      Buffer.concat([u32(1), ascii('a'), u32(1), ascii('1'), u32(1), ascii('b'), u32(2), ascii('22')]),
    ],
    [
      'lengths count bytes, not characters',
      { k: 'é' },
      Buffer.concat([u32(1), ascii('k'), u32(2), Buffer.from([0xc3, 0xa9])]),
    ],
    [
      'sorted by UTF-8 bytes, not UTF-16 code units',
      { '😀': 'x', '￿': 'y' },
      Buffer.concat([
        u32(3),
        Buffer.from([0xef, 0xbf, 0xbf]),
        u32(1),
        ascii('y'),
        u32(4),
        Buffer.from([0xf0, 0x9f, 0x98, 0x80]),
        u32(1),
        ascii('x'),
      ]),
    ],
  ])('matches the Go and Python layout for %s', (_name, encryptionContext, want) => {
    expect(canonicalContext({ encryptionContext }).equals(want)).toBe(true);
  });

  it('does not let key and value boundaries shift', () => {
    const a = canonicalContext({ encryptionContext: { a: 'bc' } });
    const b = canonicalContext({ encryptionContext: { ab: 'c' } });
    expect(a.equals(b)).toBe(false);
  });
});

describe('crc32c', () => {
  it.each([
    ['empty input', '', 0],
    ['the standard check string', '123456789', 0xe3069283],
  ])('computes the Castagnoli checksum of %s', (_name, input, want) => {
    expect(crc32c(Buffer.from(input))).toBe(want);
  });
});

describe('supports', () => {
  const ops: KmsOperation[] = ['encrypt', 'decrypt', 'generate_data_key'];

  // The KMS service has no provider-level capability gaps, so no operation raises UnsupportedError.
  it.each([
    ['aws', () => new AwsKms(awsCreds)],
    ['azure', () => new KeyVaultKms(azureCreds, 'vault')],
    ['gcp', () => new CloudKms(gcpCreds)],
    ['oci', () => new VaultKms(ociCreds, 'https://vault-crypto.example')],
  ] as [string, () => Kms][])('%s implements every operation and reports its name', (name, make) => {
    const kms = make();
    expect(kms.provider()).toBe(name);
    for (const op of ops) expect(kms.supports(op)).toBe(true);
  });

  it('rejects an operation the interface does not define', () => {
    expect(supportsKmsOperation('sign' as KmsOperation)).toBe(false);
  });
});

describe('input validation shared by every provider', () => {
  const providers: [string, () => Kms][] = [
    ['aws', () => new AwsKms(awsCreds)],
    ['azure', () => new KeyVaultKms(azureCreds, 'vault')],
    ['gcp', () => new CloudKms(gcpCreds)],
    ['oci', () => new VaultKms(ociCreds, 'https://vault-crypto.example')],
  ];

  describe.each(providers)('%s', (_name, make) => {
    it.each([
      ['encrypt without keyId', (k: Kms) => k.encrypt('', Buffer.from('x')), 'keyId'],
      ['encrypt empty plaintext', (k: Kms) => k.encrypt('key', Buffer.alloc(0)), 'input'],
      ['decrypt without keyId', (k: Kms) => k.decrypt('', Buffer.from('x')), 'keyId'],
      ['decrypt empty ciphertext', (k: Kms) => k.decrypt('key', Buffer.alloc(0)), 'input'],
      ['data key of zero bytes', (k: Kms) => k.generateDataKey('key', 0), 'numBytes'],
      ['data key of negative size', (k: Kms) => k.generateDataKey('key', -1), 'numBytes'],
      ['data key of fractional size', (k: Kms) => k.generateDataKey('key', 1.5), 'numBytes'],
      ['data key over the limit', (k: Kms) => k.generateDataKey('key', MAX_DATA_KEY_BYTES + 1), 'numBytes'],
    ])('rejects %s', async (_case, call, field) => {
      const err = await call(make()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe(field);
    });
  });
});

describe('aws AwsKms', () => {
  it.each([
    ['without a context', undefined, undefined],
    ['with a context', { encryptionContext: ctx }, ctx],
  ])('encrypt maps its arguments %s', async (_name, opts, wantCtx) => {
    awsSendMock.mockResolvedValueOnce({ CiphertextBlob: Uint8Array.from([9, 8]), KeyId: 'arn:key/1' });
    const out = await new AwsKms(awsCreds).encrypt('alias/k', Buffer.from('pt'), opts);

    const cmd = awsSendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(awsCommands.EncryptCommand);
    expect(cmd.input).toEqual({ KeyId: 'alias/k', Plaintext: Buffer.from('pt'), EncryptionContext: wantCtx });
    expect(out.ciphertext).toEqual(Buffer.from([9, 8]));
    expect(out.keyId).toBe('arn:key/1');
  });

  it('decrypt pins the key and passes the context', async () => {
    awsSendMock.mockResolvedValueOnce({ Plaintext: Uint8Array.from([1, 2]) });
    const out = await new AwsKms(awsCreds).decrypt('arn:key/1', Buffer.from('ct'), { encryptionContext: ctx });

    const cmd = awsSendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(awsCommands.DecryptCommand);
    expect(cmd.input).toEqual({ KeyId: 'arn:key/1', CiphertextBlob: Buffer.from('ct'), EncryptionContext: ctx });
    expect(out).toEqual(Buffer.from([1, 2]));
  });

  it('generateDataKey maps size and context and returns both copies', async () => {
    awsSendMock.mockResolvedValueOnce({
      Plaintext: Uint8Array.from([1]),
      CiphertextBlob: Uint8Array.from([2]),
      KeyId: 'arn:key/1',
    });
    const out = await new AwsKms(awsCreds).generateDataKey('k', 32, { encryptionContext: ctx });

    const cmd = awsSendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(awsCommands.GenerateDataKeyCommand);
    expect(cmd.input).toEqual({ KeyId: 'k', NumberOfBytes: 32, EncryptionContext: ctx });
    expect(out).toEqual({ plaintext: Buffer.from([1]), ciphertext: Buffer.from([2]), keyId: 'arn:key/1' });
  });

  it.each([
    ['encrypt', (k: Kms) => k.encrypt('k', Buffer.from('x')), 'Encrypt'],
    ['decrypt', (k: Kms) => k.decrypt('k', Buffer.from('x')), 'Decrypt'],
    ['generateDataKey', (k: Kms) => k.generateDataKey('k', 16), 'GenerateDataKey'],
  ])('%s wraps service errors as ProviderError', async (_name, call, operation) => {
    awsSendMock.mockRejectedValueOnce(new Error('denied'));
    const err = await call(new AwsKms(awsCreds)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain(operation);
  });
});

describe('azure KeyVaultKms', () => {
  const vaultUrl = 'https://vault.vault.azure.net/';
  const newKms = () => new KeyVaultKms(azureCreds, 'vault');
  const emptyDigest = sha256(Buffer.alloc(0));

  it.each([
    ['name', 'myvault', 'https://myvault.vault.azure.net/'],
    ['url', 'https://myhsm.managedhsm.azure.net', 'https://myhsm.managedhsm.azure.net/'],
    ['url with trailing slashes', 'https://myhsm.managedhsm.azure.net//', 'https://myhsm.managedhsm.azure.net/'],
  ])('vaultBaseUrl accepts a %s', (_name, input, want) => {
    expect(vaultBaseUrl(input)).toBe(want);
  });

  it('requires a vault', () => {
    expect(() => new KeyVaultKms(azureCreds, '')).toThrow(InvalidCredentialsError);
  });

  it.each([
    ['without a context', undefined, emptyDigest],
    ['with a context', { encryptionContext: ctx }, sha256(canonicalContext({ encryptionContext: ctx }))],
  ])('encrypt frames the digest of the canonical context before the payload %s', async (_name, opts, digest) => {
    azureMocks.encrypt.mockResolvedValueOnce({ result: Uint8Array.from([7]), keyID: `${vaultUrl}keys/k/v1` });
    const out = await newKms().encrypt('k/v1', Buffer.from('pt'), opts);

    expect(azureMocks.encrypt).toHaveBeenCalledWith({
      algorithm: 'RSA-OAEP-256',
      plaintext: Buffer.concat([digest, Buffer.from('pt')]),
    });
    expect(out).toEqual({ ciphertext: Buffer.from([7]), keyId: `${vaultUrl}keys/k/v1` });
    expect(azureMocks.getKey).not.toHaveBeenCalled();
  });

  it('digest of a known context is stable across SDKs', () => {
    const want = sha256(Buffer.concat([u32(1), ascii('a'), u32(1), ascii('1')]));
    expect(sha256(canonicalContext({ encryptionContext: { a: '1' } })).equals(want)).toBe(true);
    expect(emptyDigest.toString('hex')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it.each([
    ['bare name resolves the current version', 'k', 'k', `${vaultUrl}keys/k/cur`, true],
    ['name/version is used as given', 'k/v2', 'k', `${vaultUrl}keys/k/v2`, false],
    ['full url with version', `${vaultUrl}keys/k/v3`, 'k', `${vaultUrl}keys/k/v3`, false],
    ['full url without version resolves', `${vaultUrl}keys/k`, 'k', `${vaultUrl}keys/k/cur`, true],
    ['url host match ignores case', 'https://VAULT.vault.azure.net/keys/k/v4', 'k', `${vaultUrl}keys/k/v4`, false],
  ])('keyId form: %s', async (_name, keyId, wantName, wantKid, wantLookup) => {
    azureMocks.getKey.mockResolvedValue({ properties: { version: 'cur' } });
    azureMocks.encrypt.mockResolvedValue({ result: Uint8Array.from([1]) });
    await newKms().encrypt(keyId, Buffer.from('x'));

    expect(azureMocks.cryptoKeyIds).toEqual([wantKid]);
    if (wantLookup) expect(azureMocks.getKey).toHaveBeenCalledWith(wantName);
    else expect(azureMocks.getKey).not.toHaveBeenCalled();
  });

  it('reuses the cryptography client for the same key', async () => {
    azureMocks.encrypt.mockResolvedValue({ result: Uint8Array.from([1]) });
    const kms = newKms();
    await kms.encrypt('k/v1', Buffer.from('x'));
    await kms.encrypt('k/v1', Buffer.from('y'));
    expect(azureMocks.cryptoKeyIds).toHaveLength(1);
  });

  it.each([
    ['a key in another vault', 'https://other.vault.azure.net/keys/k/v1'],
    ['a url with too many segments', `${vaultUrl}keys/k/v1/extra`],
    ['a url with no key name', `${vaultUrl}keys/`],
    ['a name/version with extra slash', 'k/v1/extra'],
    ['a leading slash', '/v1'],
  ])('rejects %s', async (_name, keyId) => {
    await expect(newKms().encrypt(keyId, Buffer.from('x'))).rejects.toBeInstanceOf(ValidationError);
    expect(azureMocks.encrypt).not.toHaveBeenCalled();
  });

  it('fails when the key has no current version', async () => {
    azureMocks.getKey.mockResolvedValueOnce({ properties: {} });
    await expect(newKms().encrypt('k', Buffer.from('x'))).rejects.toBeInstanceOf(ProviderError);
  });

  it('wraps a GetKey failure as ProviderError', async () => {
    azureMocks.getKey.mockRejectedValueOnce(new Error('forbidden'));
    await expect(newKms().encrypt('k', Buffer.from('x'))).rejects.toThrow(/GetKey/);
  });

  it('wraps an encrypt failure as ProviderError', async () => {
    azureMocks.encrypt.mockRejectedValueOnce(new Error('boom'));
    await expect(newKms().encrypt('k/v1', Buffer.from('x'))).rejects.toThrow(/Encrypt/);
  });

  it('decrypt strips the context digest and returns the payload', async () => {
    const digest = sha256(canonicalContext({ encryptionContext: ctx }));
    azureMocks.decrypt.mockResolvedValueOnce({ result: Buffer.concat([digest, Buffer.from('pt')]) });
    const out = await newKms().decrypt('k/v1', Buffer.from('ct'), { encryptionContext: ctx });

    expect(azureMocks.decrypt).toHaveBeenCalledWith({ algorithm: 'RSA-OAEP-256', ciphertext: Buffer.from('ct') });
    expect(out).toEqual(Buffer.from('pt'));
  });

  it.each([
    ['a different context', { encryptionContext: { tenant: 'other' } }],
    ['no context when one was bound', undefined],
  ])('decrypt rejects %s', async (_name, opts) => {
    const digest = sha256(canonicalContext({ encryptionContext: ctx }));
    azureMocks.decrypt.mockResolvedValueOnce({ result: Buffer.concat([digest, Buffer.from('pt')]) });
    await expect(newKms().decrypt('k/v1', Buffer.from('ct'), opts)).rejects.toThrow(/context does not match/);
  });

  it.each([
    ['exactly a digest and no payload', emptyDigest],
    ['shorter than a digest', Buffer.from('short')],
  ])('decrypt rejects output that is %s', async (_name, result) => {
    azureMocks.decrypt.mockResolvedValueOnce({ result });
    await expect(newKms().decrypt('k/v1', Buffer.from('ct'))).rejects.toBeInstanceOf(ProviderError);
  });

  it('decrypt wraps service errors', async () => {
    azureMocks.decrypt.mockRejectedValueOnce(new Error('boom'));
    await expect(newKms().decrypt('k/v1', Buffer.from('ct'))).rejects.toThrow(/Decrypt/);
  });

  it('generateDataKey generates locally and encrypts under the key', async () => {
    azureMocks.encrypt.mockResolvedValueOnce({ result: Uint8Array.from([5]), keyID: `${vaultUrl}keys/k/v1` });
    const out = await newKms().generateDataKey('k/v1', 24, { encryptionContext: ctx });

    expect(out.plaintext).toHaveLength(24);
    const sent = azureMocks.encrypt.mock.calls[0][0].plaintext as Buffer;
    expect(sent.subarray(0, 32).equals(sha256(canonicalContext({ encryptionContext: ctx })))).toBe(true);
    expect(sent.subarray(32).equals(out.plaintext)).toBe(true);
    expect(out.ciphertext).toEqual(Buffer.from([5]));
    expect(out.keyId).toBe(`${vaultUrl}keys/k/v1`);
  });
});

describe('gcp CloudKms', () => {
  const keyName = 'projects/p/locations/l/keyRings/r/cryptoKeys/k';
  const ct = Buffer.from('cipher');
  const goodEncrypt = (aad = false) => ({
    ciphertext: ct,
    ciphertextCrc32c: { value: crc32c(ct) },
    verifiedPlaintextCrc32c: true,
    verifiedAdditionalAuthenticatedDataCrc32c: aad,
    name: `${keyName}/cryptoKeyVersions/3`,
  });

  it('encrypt sends checksums and the canonical context as AAD', async () => {
    gcpMocks.encrypt.mockResolvedValueOnce([goodEncrypt(true)]);
    const out = await new CloudKms(gcpCreds).encrypt(keyName, Buffer.from('pt'), { encryptionContext: ctx });

    const aad = canonicalContext({ encryptionContext: ctx });
    expect(gcpMocks.encrypt).toHaveBeenCalledWith({
      name: keyName,
      plaintext: Buffer.from('pt'),
      plaintextCrc32c: { value: crc32c(Buffer.from('pt')) },
      additionalAuthenticatedData: aad,
      additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
    });
    expect(out).toEqual({ ciphertext: ct, keyId: `${keyName}/cryptoKeyVersions/3` });
  });

  it('encrypt omits the AAD fields when there is no context', async () => {
    gcpMocks.encrypt.mockResolvedValueOnce([goodEncrypt()]);
    await new CloudKms(gcpCreds).encrypt(keyName, Buffer.from('pt'));

    expect(Object.keys(gcpMocks.encrypt.mock.calls[0][0]).sort()).toEqual(['name', 'plaintext', 'plaintextCrc32c']);
  });

  it.each([
    ['plaintext checksum not verified', { ...goodEncrypt(), verifiedPlaintextCrc32c: false }, undefined],
    ['AAD checksum not verified', goodEncrypt(false), { encryptionContext: ctx }],
    ['ciphertext checksum mismatch', { ...goodEncrypt(), ciphertextCrc32c: { value: 1 } }, undefined],
    ['ciphertext checksum missing', { ...goodEncrypt(), ciphertextCrc32c: undefined }, undefined],
  ])('encrypt fails on %s', async (_name, resp, opts) => {
    gcpMocks.encrypt.mockResolvedValueOnce([resp]);
    await expect(new CloudKms(gcpCreds).encrypt(keyName, Buffer.from('pt'), opts)).rejects.toThrow(/crc32c/);
  });

  it('encrypt wraps service errors', async () => {
    gcpMocks.encrypt.mockRejectedValueOnce(new Error('boom'));
    await expect(new CloudKms(gcpCreds).encrypt(keyName, Buffer.from('pt'))).rejects.toThrow(/Encrypt/);
  });

  it.each([
    ['a key version name', `${keyName}/cryptoKeyVersions/3`],
    ['a crypto key name', keyName],
  ])('decrypt sends the crypto key for %s', async (_name, keyId) => {
    const pt = Buffer.from('pt');
    gcpMocks.decrypt.mockResolvedValueOnce([{ plaintext: pt, plaintextCrc32c: { value: crc32c(pt) } }]);
    const out = await new CloudKms(gcpCreds).decrypt(keyId, ct, { encryptionContext: ctx });

    const aad = canonicalContext({ encryptionContext: ctx });
    expect(gcpMocks.decrypt).toHaveBeenCalledWith({
      name: keyName,
      ciphertext: ct,
      ciphertextCrc32c: { value: crc32c(ct) },
      additionalAuthenticatedData: aad,
      additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
    });
    expect(out).toEqual(pt);
  });

  it('decrypt fails when the plaintext checksum does not match', async () => {
    gcpMocks.decrypt.mockResolvedValueOnce([{ plaintext: Buffer.from('pt'), plaintextCrc32c: { value: 1 } }]);
    await expect(new CloudKms(gcpCreds).decrypt(keyName, ct)).rejects.toThrow(/crc32c/);
  });

  it('decrypt wraps service errors', async () => {
    gcpMocks.decrypt.mockRejectedValueOnce(new Error('boom'));
    await expect(new CloudKms(gcpCreds).decrypt(keyName, ct)).rejects.toThrow(/Decrypt/);
  });

  it('generateDataKey generates locally and encrypts under the key', async () => {
    gcpMocks.encrypt.mockResolvedValueOnce([goodEncrypt(true)]);
    const out = await new CloudKms(gcpCreds).generateDataKey(keyName, 32, { encryptionContext: ctx });

    expect(out.plaintext).toHaveLength(32);
    expect(gcpMocks.encrypt.mock.calls[0][0].plaintext).toEqual(out.plaintext);
    expect(out.ciphertext).toEqual(ct);
    expect(out.keyId).toBe(`${keyName}/cryptoKeyVersions/3`);
  });

  it('close releases the channel', async () => {
    await new CloudKms(gcpCreds).close();
    expect(gcpMocks.close).toHaveBeenCalledOnce();
  });
});

describe('oci VaultKms', () => {
  const endpoint = 'https://vault-crypto.example';
  const keyOcid = 'ocid1.key.oc1..a';

  it('requires a crypto endpoint and points the client at it', () => {
    expect(() => new VaultKms(ociCreds, '')).toThrow(InvalidCredentialsError);
    new VaultKms(ociCreds, endpoint);
    expect(ociMocks.crypto.endpoint).toBe(endpoint);
  });

  it.each([
    ['without a context', undefined, undefined],
    ['with a context', { encryptionContext: ctx }, ctx],
  ])('encrypt maps its arguments %s', async (_name, opts, wantCtx) => {
    ociMocks.crypto.encrypt.mockResolvedValueOnce({ encryptedData: { ciphertext: 'opaque-ct', keyId: `${keyOcid}v` } });
    const out = await new VaultKms(ociCreds, endpoint).encrypt(keyOcid, Buffer.from('pt'), opts);

    expect(ociMocks.crypto.encrypt).toHaveBeenCalledWith({
      encryptDataDetails: {
        keyId: keyOcid,
        plaintext: Buffer.from('pt').toString('base64'),
        associatedData: wantCtx,
        encryptionAlgorithm: 'AES_256_GCM',
      },
    });
    expect(out).toEqual({ ciphertext: Buffer.from('opaque-ct', 'utf8'), keyId: `${keyOcid}v` });
  });

  it('encrypt falls back to the requested key when the response has none', async () => {
    ociMocks.crypto.encrypt.mockResolvedValueOnce({ encryptedData: { ciphertext: 'ct' } });
    const out = await new VaultKms(ociCreds, endpoint).encrypt(keyOcid, Buffer.from('pt'));
    expect(out.keyId).toBe(keyOcid);
  });

  it('encrypt fails on an empty ciphertext', async () => {
    ociMocks.crypto.encrypt.mockResolvedValueOnce({ encryptedData: {} });
    await expect(new VaultKms(ociCreds, endpoint).encrypt(keyOcid, Buffer.from('pt'))).rejects.toThrow(
      /empty ciphertext/,
    );
  });

  it('encrypt wraps service errors', async () => {
    ociMocks.crypto.encrypt.mockRejectedValueOnce(new Error('boom'));
    await expect(new VaultKms(ociCreds, endpoint).encrypt(keyOcid, Buffer.from('pt'))).rejects.toThrow(/Encrypt/);
  });

  it('decrypt sends the ciphertext string and decodes the plaintext', async () => {
    ociMocks.crypto.decrypt.mockResolvedValueOnce({
      decryptedData: { plaintext: Buffer.from('pt').toString('base64') },
    });
    const out = await new VaultKms(ociCreds, endpoint).decrypt(keyOcid, Buffer.from('opaque-ct'), {
      encryptionContext: ctx,
    });

    expect(ociMocks.crypto.decrypt).toHaveBeenCalledWith({
      decryptDataDetails: {
        keyId: keyOcid,
        ciphertext: 'opaque-ct',
        associatedData: ctx,
        encryptionAlgorithm: 'AES_256_GCM',
      },
    });
    expect(out).toEqual(Buffer.from('pt'));
  });

  it('decrypt fails on an empty plaintext', async () => {
    ociMocks.crypto.decrypt.mockResolvedValueOnce({ decryptedData: {} });
    await expect(new VaultKms(ociCreds, endpoint).decrypt(keyOcid, Buffer.from('ct'))).rejects.toThrow(
      /empty plaintext/,
    );
  });

  it('decrypt wraps service errors', async () => {
    ociMocks.crypto.decrypt.mockRejectedValueOnce(new Error('boom'));
    await expect(new VaultKms(ociCreds, endpoint).decrypt(keyOcid, Buffer.from('ct'))).rejects.toThrow(/Decrypt/);
  });

  it.each([16, 24, 32])('generateDataKey uses the native API for %i bytes', async (size) => {
    ociMocks.crypto.generateDataEncryptionKey.mockResolvedValueOnce({
      generatedKey: { plaintext: Buffer.alloc(size, 1).toString('base64'), ciphertext: 'wrapped' },
    });
    const out = await new VaultKms(ociCreds, endpoint).generateDataKey(keyOcid, size, { encryptionContext: ctx });

    expect(ociMocks.crypto.generateDataEncryptionKey).toHaveBeenCalledWith({
      generateKeyDetails: {
        keyId: keyOcid,
        includePlaintextKey: true,
        keyShape: { algorithm: 'AES', length: size },
        associatedData: ctx,
      },
    });
    expect(ociMocks.crypto.encrypt).not.toHaveBeenCalled();
    expect(out).toEqual({ plaintext: Buffer.alloc(size, 1), ciphertext: Buffer.from('wrapped'), keyId: keyOcid });
  });

  it.each([1, 48, 64])('generateDataKey generates %i bytes locally and encrypts them', async (size) => {
    ociMocks.crypto.encrypt.mockResolvedValueOnce({ encryptedData: { ciphertext: 'wrapped', keyId: keyOcid } });
    const out = await new VaultKms(ociCreds, endpoint).generateDataKey(keyOcid, size);

    expect(ociMocks.crypto.generateDataEncryptionKey).not.toHaveBeenCalled();
    expect(out.plaintext).toHaveLength(size);
    const sent = ociMocks.crypto.encrypt.mock.calls[0][0].encryptDataDetails.plaintext;
    expect(sent).toBe(out.plaintext.toString('base64'));
    expect(out.ciphertext).toEqual(Buffer.from('wrapped'));
  });

  it('native generateDataKey requires a keyId', async () => {
    await expect(new VaultKms(ociCreds, endpoint).generateDataKey('', 32)).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ['plaintext', { ciphertext: 'c' }, /empty plaintext/],
    ['ciphertext', { plaintext: Buffer.from('k').toString('base64') }, /empty ciphertext/],
  ])('native generateDataKey fails on an empty %s', async (_name, generatedKey, want) => {
    ociMocks.crypto.generateDataEncryptionKey.mockResolvedValueOnce({ generatedKey });
    await expect(new VaultKms(ociCreds, endpoint).generateDataKey(keyOcid, 32)).rejects.toThrow(want);
  });

  it('native generateDataKey wraps service errors', async () => {
    ociMocks.crypto.generateDataEncryptionKey.mockRejectedValueOnce(new Error('boom'));
    await expect(new VaultKms(ociCreds, endpoint).generateDataKey(keyOcid, 32)).rejects.toThrow(
      /GenerateDataEncryptionKey/,
    );
  });

  describe('resolveCryptoEndpoint', () => {
    it('returns the vault crypto endpoint', async () => {
      ociMocks.vault.getVault.mockResolvedValueOnce({ vault: { cryptoEndpoint: endpoint } });
      await expect(resolveCryptoEndpoint(ociCreds, 'ocid1.vault.oc1..a')).resolves.toBe(endpoint);
      expect(ociMocks.vault.getVault).toHaveBeenCalledWith({ vaultId: 'ocid1.vault.oc1..a' });
    });

    it('requires a vault OCID', async () => {
      await expect(resolveCryptoEndpoint(ociCreds, '')).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('fails when the vault has no endpoint', async () => {
      ociMocks.vault.getVault.mockResolvedValueOnce({ vault: {} });
      await expect(resolveCryptoEndpoint(ociCreds, 'ocid1.vault.oc1..a')).rejects.toBeInstanceOf(ProviderError);
    });

    it('wraps service errors', async () => {
      ociMocks.vault.getVault.mockRejectedValueOnce(new Error('boom'));
      await expect(resolveCryptoEndpoint(ociCreds, 'ocid1.vault.oc1..a')).rejects.toThrow(/GetVault/);
    });
  });
});
