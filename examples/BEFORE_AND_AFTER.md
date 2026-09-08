# Before and after

The same work, written directly against each cloud's SDK, and written against
this one. Every "before" snippet is the real call this SDK makes internally, so
nothing here is strawmanned — it is exactly the code you would otherwise own.

---

## 1. Getting credentials

### Before

Four different auth models, and your application holds long-lived secrets for
every cloud it touches.

```ts
// AWS — access keys in the environment, or an STS assume-role dance
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Azure — a service principal, three separate values
const blob = new BlobServiceClient(
  `https://${process.env.AZURE_STORAGE_ACCOUNT}.blob.core.windows.net/`,
  new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!,
  ),
);

// GCP — a service-account JSON key, usually a file on disk
const gcs = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
  credentials: JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON!),
});

// OCI — a tenancy, a user, a fingerprint and a PEM private key
const oci = new ObjectStorageClient({
  authenticationDetailsProvider: new common.SimpleAuthenticationDetailsProvider(
    process.env.OCI_TENANCY!,
    process.env.OCI_USER!,
    process.env.OCI_FINGERPRINT!,
    process.env.OCI_PRIVATE_KEY!,
    null,
    common.Region.fromRegionId(process.env.OCI_REGION!),
  ),
});
```

That is four rotation stories, four blast radii, and four ways to leak a key.

### After

One credential, and it is not a cloud credential.

```ts
const client = await createClient({
  apiKey: process.env.API_KEY!,     // fc_<keyid>_<secret>
  entityId: process.env.ENTITY_ID!, // which cloud account to act as
});
```

Your app never holds an access key, a client secret or a private key. The entity
decides which cloud this is. Credentials are fetched per client, envelope
encrypted with a key pair that never leaves the process, and discarded with it.

---

## 2. Writing and reading an object

### Before

```ts
// AWS
await s3.send(new PutObjectCommand({ Bucket: b, Key: k, Body: data, ContentType: 'text/plain' }));
const res = await s3.send(new GetObjectCommand({ Bucket: b, Key: k }));
const body = Buffer.from(await res.Body!.transformToByteArray());

// Azure — containers, not buckets; block blobs, not objects
await blob.getContainerClient(b).getBlockBlobClient(k).uploadData(Buffer.from(data));
const dl = await blob.getContainerClient(b).getBlockBlobClient(k).download();
const body = await streamToBuffer(dl.readableStreamBody!);   // you write this helper

// GCP
await gcs.bucket(b).file(k).save(Buffer.from(data), { contentType: 'text/plain' });
const [body] = await gcs.bucket(b).file(k).download();

// OCI — needs a namespace, and contentLength up front
await oci.putObject({
  namespaceName: ns, bucketName: b, objectName: k,
  contentLength: Buffer.byteLength(data), putObjectBody: Buffer.from(data),
  contentType: 'text/plain',
});
const out = await oci.getObject({ namespaceName: ns, bucketName: b, objectName: k });
const body = await streamToBuffer(out.value);                // and this one
```

Four APIs, four vocabularies, two stream helpers you have to write and test.

### After

```ts
await client.storage.put(b, k, data, { contentType: 'text/plain' });
const body = await client.storage.get(b, k);
```

Identical on all four. `get` always returns a `Buffer`.

---

## 3. Supporting more than one cloud

### Before

Every call site grows a switch, and the switch spreads.

```ts
async function upload(provider: string, bucket: string, key: string, data: Buffer) {
  switch (provider) {
    case 'aws':
      return s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data }));
    case 'azure':
      return blob.getContainerClient(bucket).getBlockBlobClient(key).uploadData(data);
    case 'gcp':
      return gcs.bucket(bucket).file(key).save(data);
    case 'oci':
      return oci.putObject({
        namespaceName: ns, bucketName: bucket, objectName: key,
        contentLength: data.length, putObjectBody: data,
      });
  }
}
```

Now write that again for `get`, `delete`, `list`, `head`, `copy`, and the other
25 storage operations. Then again for secrets. Then keep four SDKs' breaking
changes in step.

### After

```ts
async function upload(client: Client, bucket: string, key: string, data: Buffer) {
  return client.storage.put(bucket, key, data);
}
```

There is no switch, because the entity already answered the question.

---

## 4. Presigned URLs

The operation where the clouds diverge most, and where the sharp edges live.

### Before

```ts
// AWS — a dedicated presigner package
const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: b, Key: k }), { expiresIn: 900 });

// Azure — build SAS values, sign them, then assemble the URL yourself.
// And with only a service principal you must first fetch a user delegation key.
const sas = generateBlobSASQueryParameters(
  {
    containerName: b, blobName: k,
    permissions: BlobSASPermissions.parse('r'),
    protocol: SASProtocol.Https,
    startsOn: new Date(Date.now() - 5 * 60_000),   // clock skew, or it fails intermittently
    expiresOn: new Date(Date.now() + 900_000),
  },
  sharedKeyCredential,
).toString();
const url = `https://${account}.blob.core.windows.net/${b}/${k}?${sas}`;

// GCP — v4 signing, and it needs the private key, not just an access token
const [url] = await gcs.bucket(b).file(k).getSignedUrl({
  version: 'v4', action: 'read', expires: Date.now() + 900_000,
});

// OCI — create a pre-authenticated request, then notice accessUri is a RELATIVE
// path and prepend the object-storage host yourself
const par = await oci.createPreauthenticatedRequest({
  namespaceName: ns, bucketName: b,
  createPreauthenticatedRequestDetails: {
    name: `par-${Date.now()}`, objectName: k,
    accessType: models.CreatePreauthenticatedRequestDetails.AccessType.ObjectRead,
    timeExpires: new Date(Date.now() + 900_000),
  },
});
const url = `https://objectstorage.${region}.oraclecloud.com${par.preauthenticatedRequest.accessUri}`;
```

The clock-skew window and the OCI relative path are both real bugs people hit in
production. The second one existed in our own Go SDK until this port found it.

### After

```ts
const url = await client.storage.presignGet(b, k, 900);
```

Absolute URL on every provider. The skew window, the delegation-key fallback and
the OCI host prefix are handled inside.

---

## 5. When a cloud simply cannot do something

### Before

You find out in production, from an error that does not explain itself.

```ts
// GCS has no object tags. This throws something unhelpful, or silently does
// nothing, depending on which call you reached for.
await gcs.bucket(b).file(k).setMetadata({ /* ...there is no tags field... */ });
```

### After

You can ask first, or catch a typed error that names the alternative.

```ts
if (client.storage.supports('set_tags')) {
  await client.storage.setTags(b, k, { owner: 'platform' });
}

// or
try {
  await client.storage.setTags(b, k, { owner: 'platform' });
} catch (err) {
  if (isUnsupported(err)) {
    // "gcp: setTags is not supported on this provider. GCS has no object tags."
  }
}
```

Every gap is enumerated in [`../docs/API_SURFACE.md`](../docs/API_SURFACE.md),
and `bun run coverage` regenerates that table from the source.

---

## Scorecard

| | Direct cloud SDKs | This SDK |
|---|---|---|
| Credentials in your app | access keys, client secrets, private keys, per cloud | one FluidCloud API key |
| Credential rotation | four stories | one |
| APIs to learn | four vocabularies | one, 172 methods |
| Adding a second cloud | a switch at every call site | change the entity |
| Streams | write your own buffer helpers | `Buffer` and `Readable` throughout |
| Capability gaps | discovered in production | `supports()` and typed `UnsupportedError` |
| Install size | all four sets if you support all four | only the clouds your entities use |

---

## What this SDK does not do for you

Worth stating plainly, so the trade is clear.

- **It is a common denominator with escape hatches, not a full mapping.** 172
  methods across 13 services, not the entirety of any cloud's API. Reach past it
  and you are back on the native SDK.
- **Emulated behavior is emulated.** OCI object tags live in `tag_` prefixed
  metadata; Kinesis consumer groups are checkpointed by the SDK, not the service.
  Both behave correctly, but they are not native primitives.
- **You still install each cloud's packages** for the clouds your entities use.
  The SDK is the wrapper, not a replacement for the underlying SDKs.
- **It needs the FluidCloud server** to fetch credentials. That is a dependency
  the raw SDKs do not have.
