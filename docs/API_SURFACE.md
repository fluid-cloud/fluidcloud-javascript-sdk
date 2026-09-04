# FluidCloud JS SDK — API Surface & Cross-Provider Coverage

13 services, **172 methods**, four providers. Every class `implements` its
TypeScript interface, so the method count is compiler-enforced rather than
asserted.

Legend: **native** = the provider does this directly · **emulated** = the SDK
builds it out of other calls, and it behaves like the real thing · **⛔** = throws
`UnsupportedError` naming the gap and the alternative.

Parity target is the Go SDK. Where Go leaves a gap, this SDK leaves the same gap
— including cases where the JS library could have done more. Those are called out
below as *Go-side gaps*.

---

## Coverage at a glance

Generated from the source by `bun run coverage` — not hand-maintained. `N + kX`
means N methods implemented and k throwing `UnsupportedError`. Every cell is
verified to match the Go SDK exactly; the two gap sets are identical.

| Service | Methods | AWS | Azure | GCP | OCI |
|---|---:|---|---|---|---|
| storage | 31 | 31 | 31 | 24 + 7X | 31 |
| secrets | 14 | 14 | 14 | 12 + 2X | 14 |
| parameters | 10 | 10 | 10 | 10 | 10 |
| messaging | 7 | 7 | 7 | 7 | 7 |
| queue | 7 | 7 | 7 | 7 | 7 |
| email | 5 | 5 | 1 + 4X | 0 + 5X | 5 |
| monitoring | 9 | 9 | 9 | 4 + 5X | 9 |
| audit | 5 | 5 | 2 + 3X | 1 + 4X | 2 + 3X |
| streaming | 9 | 9 | 9 | 8 + 1X | 9 |
| cdn | 10 | 10 | 8 + 2X | 7 + 3X | 0 + 10X |
| identity | 22 | 22 | 21 + 1X | 10 + 12X | 16 + 6X |
| cache | 29 | 29 | 29 | 29 | 29 |
| search | 14 | 14 | 11 + 3X | 0 + 14X | 14 |
| **TOTAL** | **172** | **172** | **159 + 13X** | **119 + 53X** | **153 + 19X** |

603 implemented + 85 unsupported = 688 of 688 method/provider pairs. Nothing is
unimplemented: every method exists on every provider and either works or tells
you precisely why it cannot.

## Where the gaps are, and why

### Storage
GCS has no S3-style multipart upload (`multipartCreate`, `multipartUploadPart`,
`multipartComplete`, `multipartAbort` ⛔ — use `upload()`, which streams a
resumable upload) and no object tags (`getTags`, `setTags`, `deleteTags` ⛔).

OCI emulates object tags in `tag_`-prefixed metadata via a self-copy, so they
behave like real tags. Azure's `multipartAbort` is a no-op because uncommitted
blocks expire on their own; its `multipartCreate` mints a synthetic upload id
since Azure has no create step.

Presigned URLs work everywhere but by different means: S3 request signing, Azure
SAS (shared-key when `storageAccountKey` is set, else a user-delegation key over
AAD), GCS V4 signing, and OCI pre-authenticated requests.

### Secrets
GCP deletes are permanent, so `restore` ⛔; GCP has no on-demand rotation trigger,
so `rotateSecret` ⛔. Elsewhere `rotateSecret` is emulated as get-then-put, which
is what the Go SDK does. Binary secrets round-trip natively on AWS and GCP, and
via base64 on Azure and OCI.

### Parameters
OCI has no parameter store at all — `VaultParameters` adapts the `Secrets`
interface, so every parameter is a Vault secret. Azure has no version ids, so a
version *is* the setting ETag. GCP resolves the newest **enabled** version and has
to delete all versions before deleting a parameter.

### Email
GCP has no email service in the Go SDK, so all 5 ⛔. Azure Communication Services
has no MIME raw send and no per-address verification API, leaving only
`sendEmail`.

### Monitoring
GCP metrics and alarms are **not wired in the Go SDK** — `putMetrics`,
`getMetrics`, `createAlarm`, `deleteAlarm`, `listAlarms` ⛔ even though
`@google-cloud/monitoring` is installed. That is a *Go-side gap* preserved
deliberately. GCP logging is fully native.

### Audit
Trails are an AWS concept. Azure, GCP and OCI have always-on platform audit
logging with nothing to create, so trail management ⛔ (Azure and OCI return an
empty list from `listTrails` rather than throwing, matching Go). `lookupEvents`
works everywhere, each provider's filter syntax built from the same options.

### Streaming
Kinesis is the AWS default; MSK is selected by passing `mskBootstrapServers`.
Kinesis has no consumer groups, so the SDK emulates them and checkpoints offsets
by sequence number. Azure Event Hubs manages offsets itself, so `commitOffset` is
a no-op. GCP Pub/Sub is ack-based with no partitions or offsets: `commitOffset`
⛔, and `StreamRecord.partition`/`offset` are left unset.

### CDN
OCI has no CDN — all 10 ⛔. Azure Front Door purge is fire-and-forget with no
invalidation history, so `getInvalidation`/`listInvalidations` ⛔. GCP maps
distributions onto Compute backend buckets and has no purge API, so the three
invalidation methods ⛔. CloudFront updates are read-modify-write against the
distribution ETag, including enable/disable.

### Identity
The user pool is native only on AWS. Azure Entra, GCP Identity Platform and OCI
IAM each have a single directory, so pool creation is emulated as a sentinel and
`poolId` is ignored on user and group calls. GCP has no group API in the Go SDK
(6 group methods ⛔) and no auth flows (4 ⛔). OCI SCIM has no password or auth
flow (`setPassword` and the 4 auth methods ⛔). Azure authenticates via OAuth2
ROPC against the v2.0 token endpoint.

### Cache
The one service with no gaps anywhere: all four providers speak the Redis wire
protocol, so a single implementation serves all of them and only endpoint, TLS
and auth differ. Azure always uses TLS.

### Search
AWS and OCI both speak the OpenSearch REST API and share an implementation, AWS
signing with SigV4 and OCI with basic auth. Azure AI Search is a different API:
index, document and query operations are translated, but it has no
Elasticsearch-style mapping or refresh, so `getMapping`, `putMapping` and
`refresh` ⛔. A query with no `search` key falls back to match-all rather than
throwing, matching Go. GCP has no managed OpenSearch — all 14 ⛔.

---

## Bugs found by the port, and fixed in both SDKs

Porting method-for-method surfaced seven real bugs in the Go SDK. All were first
fixed in `fluidcloud-go-sdk` (with table-driven guard tests in
`provider/oci/fixes_test.go`), then mirrored here. Both SDKs now behave the same
— correctly.

1. **OCI `sendRawEmail` dropped the message body.** It parsed the MIME headers,
   then sent with only from/to/cc/subject — no body, no Bcc, no Reply-To. A
   caller got a successful send of an empty email. Now the body is carried
   (routed to HTML or text by `Content-Type`), and Bcc and Reply-To are parsed.
2. **A hand-rolled `bytes.Reader` in the Go OCI email file returned a fake EOF**
   that was not `io.EOF`, with an `init()` comment claiming otherwise. This was
   the root cause of bug 1 — reading the body would have looked broken, so it
   got dropped. The type is deleted; Go uses `bytes.NewReader`.
3. **OCI monitoring `getLogs` swallowed failures**, returning an empty list with
   no error, so a broken query was indistinguishable from "no logs". It now
   returns the error, and honors the `limit` option instead of hardcoding 100.
4. **OCI monitoring `getLogs` stamped every event with the current time**,
   discarding the log's real timestamp. It now reads the entry's own timestamp
   from the payload (`datetime` / `time` / `timestamp`, RFC3339 or epoch millis).
5. **OCI monitoring `putLogs` ingested by log-group name, not Log OCID.** OCI
   ingestion addresses a Log by OCID, so writes went to a bogus id. It now
   resolves the group and stream to a real Log OCID and fails clearly if either
   is missing.
6. **Azure and OCI queue `sendMessage`/`receiveMessages` ignored their options.**
   Delay, attributes, visibility timeout and wait time were silently dropped.
   They are now mapped onto each service's real fields, message attributes
   round-trip through receive, and the two genuinely inexpressible cases (Service
   Bus per-receive visibility, OCI per-message delay) are documented rather than
   silently discarded.
7. **OCI streaming `commitOffset` reset the consumer group.** It ignored its
   `partition` and `offset` arguments and committed a TRIM_HORIZON group cursor,
   which commits the *earliest* offset — so committing progress rewound the group
   to the start of the stream. OCI group cursors cannot encode an offset, so
   the checkpoint is now tracked client-side and replayed by `getRecords`, the
   same emulation the Kinesis provider already used.

Still open, and **not** bugs — genuine unimplemented features in the Go SDK,
preserved here as `UnsupportedError` rather than silently diverging: GCP metrics
and alarms (`gcp/monitoring.go` wires only logging) and GCP search
(`gcp/search.go` is entirely unimplemented).

---

## Intentional divergences from Go

Small, deliberate, and confined to shape rather than behavior.

- **One credential fetch per client.** Go re-fetches the envelope for each of the
  13 services — 14 HTTPS round trips and 14 RSA keygens per client. This SDK
  fetches once and reuses it.
- **`scan` takes and returns a string cursor.** Redis cursors exceed
  `Number.MAX_SAFE_INTEGER`; Go's `uint64` has no safe JS equivalent.
- **Azure email, search and identity use the official Azure SDKs** where the Go
  code hand-rolls signed HTTP requests. Behavior, payload shapes and unsupported
  operations match; the signing is just delegated to the library.
- **GCP CDN `getDistribution` maps a gRPC NOT_FOUND to `NotFoundError`**, where Go
  wraps it generically. This matches how the Go SDK treats not-found elsewhere.
- **OCI secrets read by name** via `getSecretBundleByName`, saving the OCID lookup
  Go's older SDK version required.
- **MSK `getRecords` mints an ephemeral consumer group** when none is given.
  Go's `kafka-go` can read a partition without joining a group; `kafkajs` cannot,
  so an ephemeral group id is used and the consumer is always stopped and
  disconnected in a `finally`. Observable behavior for callers is unchanged.
- **OCI streaming base64-encodes record keys and values.** The Go SDK's types are
  `[]byte` and marshal to base64 on the wire; the JS package's generated types are
  already `string`, so the SDK encodes on produce and decodes on consume to stay
  wire-compatible with the Go SDK and the service.
