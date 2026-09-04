# FluidCloud JavaScript SDK

One API across AWS, Azure, GCP and OCI. Credentials come from FluidCloud, never
from ambient cloud config, and are delivered envelope-encrypted so they are never
readable in transit even if TLS is terminated by a proxy.

This is a port of [`fluidcloud-go-sdk`](https://github.com/fluid-cloud/fluidcloud-go-sdk) with the same 13
services and the same 172 methods, including its emulations and its deliberate
gaps.

```bash
bun add @fluid-cloud/fluidcloud-js-sdk    # or npm install
```

Node 18 or newer. TypeScript types are bundled; ESM and CJS both work.

---

## Quick start

```ts
import { createClient } from '@fluid-cloud/fluidcloud-js-sdk';

const client = await createClient({
  apiKey: process.env.API_KEY!,     // "fc_<keyid>_<secret>", from Settings → API Keys
  entityId: process.env.ENTITY_ID!, // the cloud account to act as
});

await client.storage.put('my-bucket', 'hello.txt', 'hi');
console.log((await client.storage.get('my-bucket', 'hello.txt')).toString());

await client.close();
```

The entity decides the provider. The same code above runs against S3, Azure Blob,
GCS or OCI Object Storage with no changes.

---

## Configuration

```ts
createClient(config, options?)
```

`config`:

| field | required | notes |
|---|---|---|
| `apiKey` | yes | `fc_<keyid>_<secret>` |
| `entityId` | yes | selects the cloud account, and therefore the provider |
| `serverUrl` | no | defaults to `https://app.fluidcloud.com` |
| `region` | no | overrides the entity's region |

`options` carries everything the entity cannot tell us — the Azure storage
account, the OCI namespace, the Redis endpoint, and so on. A service whose
required options are absent is simply not created; check the `has*` flag:

```ts
if (client.hasSearch) {
  await client.search.createIndex('products');
}
```

Reading a service that was not created throws rather than returning undefined,
so a typo surfaces immediately.

### Which options each service needs

| service | AWS | Azure | GCP | OCI |
|---|---|---|---|---|
| storage | — | `storageAccount`, `storageAccountKey` (for SAS) | — | `namespace` |
| secrets | — | `keyVaultName` | — | `vaultOcid`, `compartment`, `keyOcid` |
| parameters | — | `appConfigEndpoint` | — | `vaultOcid`, `compartment` |
| messaging / queue | — | `serviceBusNamespace` | — | `compartment` |
| email | — | `acsEndpoint`, `acsKey` | *unsupported* | `compartment` |
| monitoring | — | `resourceGroup`, `logAnalyticsWorkspaceId`, `dataCollectionEndpoint` | — | `compartment` |
| audit | — | — | — | `compartment` |
| streaming | `mskBootstrapServers` (else Kinesis) | `eventHubsNamespace`, `resourceGroup` | — | `compartment` |
| cdn | — | `cdnProfileName`, `resourceGroup` | *unsupported* | *unsupported* |
| identity | — | — | — | `identityDomainEndpoint` |
| cache | `redisEndpoint`, `redisPassword`, `redisTls`, `redisDb` | same, TLS always on | same | same |
| search | `searchEndpoint` | `searchEndpoint`, `searchApiKey` | *unsupported* | `searchEndpoint`, `searchUsername`, `searchPassword` |

---

## Services

`client.storage`, `.secrets`, `.parameters`, `.messaging`, `.queue`, `.email`,
`.monitoring`, `.audit`, `.streaming`, `.cdn`, `.identity`, `.cache`, `.search`.

```ts
// storage
const url = await client.storage.presignGet('bucket', 'report.pdf', 900, { filename: 'Q3.pdf' });
for (const obj of await client.storage.listAll('bucket', { prefix: 'logs/' })) console.log(obj.key);

// secrets
await client.secrets.put('db-password', 'hunter2', { description: 'prod' });
const versions = await client.secrets.listVersions('db-password');

// cache — every provider speaks Redis
await client.cache.set('session:42', 'active', 3600);

// queue
const id = await client.queue.sendMessage(queueId, JSON.stringify({ job: 'resize' }));
const messages = await client.queue.receiveMessages(queueId, 10, { waitTimeSeconds: 20 });
```

Runnable examples for every service are in [`examples/`](./examples).

---

## Capability differences between clouds

Not every provider can do everything, and the SDK never pretends otherwise. Three
mechanisms tell you where you stand:

```ts
// 1. ask before calling
client.storage.supports('multipart');   // false on GCS

// 2. catch a typed error
import { isUnsupported } from '@fluid-cloud/fluidcloud-js-sdk';
try {
  await client.storage.setTags(bucket, key, { owner: 'platform' });
} catch (err) {
  if (isUnsupported(err)) { /* GCS has no object tags */ }
}

// 3. read the message, which names the alternative
// "gcp: multipartCreate is not supported on this provider. GCS has no S3-style
//  multipart upload. Recommended alternative: use upload(), which streams a
//  resumable upload"
```

Some operations are *emulated* rather than missing — OCI object tags live in
`tag_`-prefixed metadata, Kinesis consumer groups are checkpointed by the SDK.
Those behave like the real thing and are documented in
[`docs/API_SURFACE.md`](./docs/API_SURFACE.md).

---

## Errors

Everything the SDK throws extends `FluidCloudError` and carries a `code`.

| class | when |
|---|---|
| `ValidationError` | config is missing or malformed |
| `EntityNotFoundError` | the entity does not exist on the server |
| `AccessDeniedError` | the API key may not read this entity |
| `InvalidCredentialsError` | the credential envelope is unusable |
| `NotFoundError` | the object, secret or parameter does not exist |
| `UnsupportedError` | this provider cannot do this |
| `ProviderError` | the underlying cloud SDK failed; `cause` holds the original |

Predicates `isNotFound`, `isAccessDenied` and `isUnsupported` walk the `cause`
chain, so they work on wrapped errors.

---

## How credentials are protected

`createClient` never reads `~/.aws/credentials` or `GOOGLE_APPLICATION_CREDENTIALS`.
Instead, per client:

1. the SDK generates an ephemeral RSA-2048 key pair in-process
2. it POSTs the public key to `/api/v1/cloudaccounts/{id}/secure-credentials`
3. the server encrypts the credentials with a random AES-256-GCM key and wraps
   that key with RSA-OAEP-SHA256
4. the SDK unwraps and decrypts locally

The private key never leaves the process and is discarded with the client, so a
compromised TLS path still yields nothing. This is wire-compatible with the Go
SDK — `test/envelope.test.ts` decrypts a fixture produced by the Go
implementation to prove it.

---

## Differences from the Go SDK

Behavior is the same; the shape is idiomatic JavaScript.

| Go | JavaScript |
|---|---|
| `ctx context.Context` first argument | dropped |
| `(T, error)` | `Promise<T>`, rejecting on failure |
| `errors.Is(err, ErrNotFound)` | `isNotFound(err)`, or `err.code` |
| `opts ...Options` variadic | single optional `opts` argument |
| `[]byte` | `Buffer` |
| `io.Reader` / `io.ReadCloser` | `Readable` |
| `time.Duration` | a number of **seconds** |
| `client.Storage()` | `client.storage`, `client.hasStorage` |
| `Scan(cursor uint64)` | `scan(cursor: string)` — Redis cursors exceed `Number.MAX_SAFE_INTEGER` |

One behavioral improvement: the Go SDK re-fetches the credential envelope once
per service, costing 14 HTTPS round trips and 14 RSA keygens per client. This SDK
fetches once and reuses it. The credentials are identical either way.

---

## Development

```bash
bun install
bun run typecheck     # tsc --noEmit
bun run test          # vitest, fully mocked, no network
bun run build         # tsup → dist/ (ESM + CJS + .d.ts)
```

Unit tests never touch a cloud. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the
conventions this codebase follows, and [`docs/API_SURFACE.md`](./docs/API_SURFACE.md)
for what each provider can and cannot do.
