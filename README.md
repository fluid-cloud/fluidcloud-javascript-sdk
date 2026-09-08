# FluidCloud JavaScript SDK

One API across AWS, Azure, GCP and OCI. Credentials come from FluidCloud, never
from ambient cloud config, and are delivered envelope-encrypted so they are never
readable in transit even if TLS is terminated by a proxy.

This is a port of [`fluidcloud-go-sdk`](https://github.com/fluid-cloud/fluidcloud-go-sdk) with the same 13
services and the same 172 methods, including its emulations and its deliberate
gaps.

## Setup

FluidCloud is the credential manager. You hand it your cloud credentials **once**,
in the portal, and from then on your application holds a single FluidCloud API
key instead of an access key, a client secret or a private key.

```
ONE TIME — in the FluidCloud portal
  /accounts             onboard a cloud account          ──▶  an entity ID
                        (AWS · Azure · GCP · OCI)
  /settings/api-keys    generate an API key              ──▶  fc_<keyid>_<secret>

EVERY RUN — in your application
  createClient({ apiKey, entityId })                     ──▶  credentials fetched
                                                              and decrypted in memory

  your app stores: the API key and the entity ID
  your app never stores: an access key, a client secret, a private key
```

### 1. Add your cloud account

In the FluidCloud portal, go to **Accounts** (`/accounts`) and onboard the cloud
account you want the SDK to act as. This is where the cloud credentials live:
AWS access keys or an assume-role ARN, an Azure service principal, a GCP
service-account JSON key, or an OCI API signing key.

Onboarding gives you an **entity ID**. That single value decides which cloud the
SDK talks to — swap it and the same code runs against a different provider.

### 2. Generate an API key

Go to **Settings → API Keys** (`/settings/api-keys`) and generate one. The key
looks like `fc_<keyid>_<secret>` and is **shown only once**, so store it as a
secret in your deployment.

Or over the API:

```bash
curl -X POST https://app.fluidcloud.com/fcauth/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email": "you@example.com", "password": "..."}' -c cookies.txt

curl -X POST https://app.fluidcloud.com/fcauth/api/v1/user/api-keys \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"name": "my-service", "description": "server-side SDK access"}'
```

### 3. Install the SDK and your cloud's packages

See [Installing](#installing) below — you install only the clouds your
entities actually use.

### 4. Create a client

```ts
const client = await createClient({
  apiKey: process.env.API_KEY!,
  entityId: process.env.ENTITY_ID!,
});
```

That is the whole setup. What happens on that call: the SDK generates an
ephemeral RSA key pair, asks the FluidCloud server for the entity's credentials,
and decrypts them in memory. The cloud credentials never appear in your
environment, your config, or your logs — and rotating them is something you do
in the portal, without redeploying anything.

---

## Installing

```bash
bun add @fluid-cloud/fluidcloud-javascript-sdk    # or npm install
```

Node 18 or newer. TypeScript types are bundled; ESM and CJS both work.

### Only the clouds you use

The cloud SDKs are **optional peer dependencies**, and provider code is loaded on
demand, so installing this package pulls in none of them. Add the set for each
cloud you actually talk to. An AWS-only install is about 61 MB; installing all
four would be about 650 MB.

**AWS** (17 packages)

```bash
bun add @aws-sdk/client-cloudfront \
  @aws-sdk/client-cloudtrail \
  @aws-sdk/client-cloudwatch \
  @aws-sdk/client-cloudwatch-logs \
  @aws-sdk/client-cognito-identity-provider \
  @aws-sdk/client-kinesis \
  @aws-sdk/client-s3 \
  @aws-sdk/client-secrets-manager \
  @aws-sdk/client-sesv2 \
  @aws-sdk/client-sns \
  @aws-sdk/client-sqs \
  @aws-sdk/client-ssm \
  @aws-sdk/credential-providers \
  @aws-sdk/s3-request-presigner \
  @opensearch-project/opensearch \
  ioredis \
  kafkajs
```

**Azure** (16 packages)

```bash
bun add @azure/app-configuration \
  @azure/arm-cdn \
  @azure/arm-eventhub \
  @azure/arm-monitor \
  @azure/arm-operationalinsights \
  @azure/communication-email \
  @azure/event-hubs \
  @azure/identity \
  @azure/keyvault-secrets \
  @azure/monitor-ingestion \
  @azure/monitor-query \
  @azure/search-documents \
  @azure/service-bus \
  @azure/storage-blob \
  @microsoft/microsoft-graph-client \
  ioredis
```

**GCP** (8 packages)

```bash
bun add @google-cloud/compute \
  @google-cloud/logging \
  @google-cloud/parametermanager \
  @google-cloud/pubsub \
  @google-cloud/secret-manager \
  @google-cloud/storage \
  firebase-admin \
  ioredis
```

**OCI** (17 packages)

```bash
bun add @opensearch-project/opensearch \
  ioredis \
  oci-audit \
  oci-common \
  oci-email \
  oci-emaildataplane \
  oci-identitydomains \
  oci-logging \
  oci-loggingingestion \
  oci-loggingsearch \
  oci-monitoring \
  oci-objectstorage \
  oci-ons \
  oci-queue \
  oci-secrets \
  oci-streaming \
  oci-vault
```

Reach for a cloud whose packages are missing and Node raises a module-not-found
error naming exactly what to install. `ioredis` appears in every list because all
four providers back the cache with Redis.

---

---

## Quick start

```ts
import { createClient } from '@fluid-cloud/fluidcloud-javascript-sdk';

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

For the same work written directly against each cloud's SDK, side by side with
this one, see [`examples/BEFORE_AND_AFTER.md`](./examples/BEFORE_AND_AFTER.md).

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

### What `options` is, and what it is not

`options` is **not credentials.** Your cloud credentials come from FluidCloud
automatically — the entity you name in `entityId` decides the provider and
carries the keys, and the SDK fetches them encrypted at construction. You never
put an access key, a client secret or a private key in here.

What `options` carries is the handful of **coordinates FluidCloud cannot know for
you**: *which* storage account, *which* vault, *which* Redis endpoint. AWS mostly
needs none of them, because an S3 bucket or an SSM parameter is addressable from
the account alone. Azure and OCI need more, because a blob lives inside a storage
account and a secret lives inside a named vault.

### What each service needs before it switches on

A service whose requirement is missing is simply not created, and its `has*` flag
is `false`. Nothing throws until you reach for it.

| Service | AWS | Azure | GCP | OCI |
|---|---|---|---|---|
| storage | nothing | `storageAccount` | nothing | `namespace` |
| secrets | nothing | `keyVaultName` | nothing | `vaultOcid` + `compartment` |
| parameters | nothing | `appConfigEndpoint` | nothing | `vaultOcid` + `compartment` |
| messaging | nothing | `serviceBusNamespace` | nothing | nothing |
| queue | nothing | `serviceBusNamespace` | nothing | nothing |
| email | nothing | `acsEndpoint` + `acsKey` | nothing † | nothing |
| monitoring | nothing | nothing | nothing | nothing |
| audit | nothing | nothing | nothing | nothing |
| streaming | nothing | `eventHubsNamespace` | nothing | nothing |
| cdn | nothing | `cdnProfileName` | nothing | nothing † |
| identity | nothing | nothing | nothing | `identityDomainEndpoint` |
| cache | `redisEndpoint` | `redisEndpoint` | `redisEndpoint` | `redisEndpoint` |
| search | `searchEndpoint` | `searchEndpoint` + `searchApiKey` | never ‡ | `searchEndpoint` |

**†** The service is created and `has*` is `true`, but the cloud has no such
product, so every method throws `UnsupportedError`. GCP has no email service and
OCI has no CDN.

**‡** GCP has no managed OpenSearch, so `search` is never created there —
`hasSearch` stays `false` whatever you pass.

On OCI, `compartment` falls back to the compartment on the entity itself, so you
usually only pass it to target a different one.

### Options that unlock specific operations

These do not gate a whole service. Without them the service still works, but
certain calls fail or behave differently.

| Option | Provider | What it unlocks |
|---|---|---|
| `storageAccountKey` | Azure | Signs presigned URLs with a shared key. Without it the SDK falls back to a user-delegation key over AAD. |
| `keyOcid` | OCI | The master encryption key used to **create** a new Vault secret. Reads and updates work without it. |
| `resourceGroup` | Azure | Alarms and log groups on monitoring, plus CDN and Event Hubs management. |
| `logAnalyticsWorkspaceId` | Azure | `monitoring.getLogs`. |
| `dataCollectionEndpoint` | Azure | `monitoring.putMetrics` and `monitoring.putLogs`. |
| `mskBootstrapServers` | AWS | Selects MSK for streaming. Left empty, streaming uses Kinesis. |
| `searchUsername` / `searchPassword` | OCI | Basic auth for OCI OpenSearch. |
| `redisPassword` / `redisTls` / `redisDb` | all | Redis auth, TLS and logical database. Azure always uses TLS. |
| `region` | AWS, OCI | Overrides the entity's region. |

Which methods each provider supports is a separate question, answered in full by
[`docs/API_SURFACE.md`](./docs/API_SURFACE.md) and by `bun run coverage`.

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

Runnable examples for every service are in [`examples/`](./examples), and
[`examples/BEFORE_AND_AFTER.md`](./examples/BEFORE_AND_AFTER.md) shows the same
tasks written against the raw cloud SDKs for comparison.

---

## Capability differences between clouds

Not every provider can do everything, and the SDK never pretends otherwise. Three
mechanisms tell you where you stand:

```ts
// 1. ask before calling
client.storage.supports('multipart');   // false on GCS

// 2. catch a typed error
import { isUnsupported } from '@fluid-cloud/fluidcloud-javascript-sdk';
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
