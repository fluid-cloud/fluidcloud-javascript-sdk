# Changelog

This project follows [semantic versioning](https://semver.org). The public
surface is what `src/index.ts` exports: the client, the 13 service interfaces,
the error taxonomy and the credential types.

- **major** — a breaking change to that surface: a removed or renamed method, a
  changed signature or return shape, or a behavioral change callers must react to
- **minor** — a new method, a new service, a new option, or a capability that
  starts working on a provider where it previously threw `UnsupportedError`
- **patch** — a bug fix, a dependency bump, or documentation

Provider capability changes are versioned by their effect on callers. A method
that starts working is a **minor**; one that stops is a **major**.

## 0.1.1 — 2026-09-08

### Changed
- Releases are published from GitHub Actions through npm trusted publishing
  (OIDC) with a signed provenance attestation, instead of from a maintainer's
  machine. No changes to the SDK itself.

## 0.1.0 — 2026-09-08

Initial release. 13 services and 172 methods across AWS, Azure, GCP and OCI.

### Added
- The cloud SDKs are optional peer dependencies: you install only the ones you
  use, and provider code loads on demand, so an app using one cloud never resolves the
  other three. An AWS-only install is about 61 MB rather than 650 MB.
- Biome for linting and formatting, run in CI.
- `bun run coverage` prints the per-provider implementation matrix.

### Fixed
- Credential key names now match what the server emits: the GCP service-account
  JSON is read from `credentials` and `serviceAccountKey`, and the OCI compartment
  from `compartmentId`. The OCI mismatch was silent — the compartment resolved to
  an empty string for messaging, queue, email, monitoring, audit and streaming
  unless the caller passed it explicitly.
- OCI presigned URLs are absolute; the service returns a relative path.
- OCI `sendRawEmail` carries the message body, Bcc and Reply-To.
- OCI monitoring `getLogs` surfaces search failures instead of returning an empty
  list, and reads each entry's own timestamp.
- OCI monitoring `putLogs` resolves a real Log OCID instead of sending the log
  group name.
- Azure and OCI queue `sendMessage`/`receiveMessages` honor their options.
- OCI streaming `commitOffset` records the given offset instead of committing a
  trim-horizon cursor, which rewound the consumer group.
