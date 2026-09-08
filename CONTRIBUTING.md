# Contributing

This SDK is a TypeScript port of FluidCloud's Go SDK. Both expose the same 13
services and the same 172 methods, and `bun run coverage` prints the matrix of
what each provider supports.

**Behavioral parity matters.** Where a cloud provider cannot do something, the
SDK throws a typed error naming the gap rather than pretending. If a change
would alter behavior rather than fix a bug — a different return shape, a
different error, a capability that starts working — say so in the PR. Keeping
the SDKs in step is the maintainers' job, not yours; you only need to flag it.

## Getting set up

```bash
bun install
bun run lint          # biome — lint and formatting
bun run lint:fix      # apply the safe fixes
bun run typecheck     # tsc --noEmit
bun run test          # vitest — fully mocked, no network, no credentials
bun run build         # tsup → dist/ (ESM + CJS + .d.ts)
bun run coverage      # per-service, per-provider implementation matrix
```

## Layout

```
src/
  client.ts                 the unified client
  config.ts  errors.ts      configuration and the error taxonomy
  credentials/              envelope-encrypted credential fetch
  provider/
    types/                  the 13 service interfaces — the contract
    initializer.ts          builds provider clients from an entity
    aws/ azure/ gcp/ oci/   one file per service, plus auth.ts and a barrel
```

`src/provider/types/*.ts` is the contract. Every provider class `implements` its
interface, so a missing or misnamed method is a compile error rather than a
runtime surprise.

## Conventions

Ported from the Go SDK, so the two read alike:

| Go | TypeScript |
|---|---|
| `ctx context.Context` first argument | dropped |
| `(T, error)` | `Promise<T>`, rejecting on failure |
| `opts ...Options` variadic | one optional `opts` argument |
| `[]byte` | `Buffer` (accept `Buffer \| Uint8Array` on input) |
| `io.Reader` / `io.ReadCloser` | `Readable` from `node:stream` |
| `time.Time` | `Date` |
| `time.Duration` | a number of **seconds**, named `...Seconds` |
| exported `Method()` | `method()` |

Errors, from `src/errors.ts`:

- wrap every provider SDK call — `wrapProviderError('aws', 'get', err)`
- throw `NotFoundError` where the resource does not exist; `exists()`-style
  methods catch it and return `false` rather than throwing
- throw `UnsupportedError` for a capability the provider genuinely lacks, naming
  the limitation and the alternative — never fail silently and never pretend

Doc-comments on exported symbols only, one terse line. No narration comments.

## Tests

Table-driven where the cases are parallel. Unit tests never touch a cloud: mock
the provider SDK with `vi.mock`. Cover the happy path's argument mapping,
not-found handling, and every `UnsupportedError`.

Live tests live in `test/e2e/` and are opt-in:

```bash
make e2e API_KEY=fc_xxx ENTITY_ID_AWS=entity-123 TEST_BUCKET=my-bucket
```

They skip, with a reason, for any provider whose credentials are absent, and
write `TEST_RESULTS.md` summarising what passed per provider.

## Versioning

Semantic versioning, with the policy and the running list of changes in
[`CHANGELOG.md`](./CHANGELOG.md). Add an entry under **Unreleased** in the same
PR as the change — it is much harder to reconstruct later.

Releases are cut from GitHub: bump `version` in `package.json`, merge, then
publish a Release whose tag matches it. The release workflow refuses to publish
when the tag and `package.json` disagree.

## Pull requests

Keep them reviewable — one service per commit, and split large work into stacked
branches rather than one sprawling diff. A PR must leave `bun run typecheck`,
`bun run test` and `bun run build` green.
