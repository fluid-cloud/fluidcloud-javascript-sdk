# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub Security Advisories:
[Report a vulnerability](https://github.com/fluid-cloud/fluidcloud-javascript-sdk/security/advisories/new)

We will acknowledge within three working days and keep you updated as we
investigate. If you would like credit in the advisory, say so and tell us how you
would like to be named.

## What is in scope

- Anything that could expose cloud credentials or the FluidCloud API key
- Flaws in the credential envelope: the ephemeral key exchange, the AES-256-GCM
  decryption, or the transport around them
- Injection through values callers pass to SDK methods
- Dependency vulnerabilities reachable from code paths this SDK actually calls

## What is not

- Vulnerabilities in AWS, Azure, GCP or OCI themselves — report those to the
  provider
- Capability gaps documented in [`docs/API_SURFACE.md`](./docs/API_SURFACE.md); a
  provider that cannot do something is a limitation, not a vulnerability
- Advisories against an optional peer dependency you have installed but the SDK
  never calls
- Findings from an automated scanner with no demonstrated impact on this SDK

## Handling credentials

This SDK never reads ambient cloud configuration and never writes credentials to
disk. Credentials are fetched per client, envelope encrypted, decrypted in memory
with a key pair that never leaves the process, and discarded with the client.

If you believe a credential has been exposed, rotate it in the FluidCloud portal
first, then report.

## The committed test key

`test/fixtures/insecure-test-keypair.json` holds a real RSA private key. It is
deliberately public, was generated only to prove the envelope is byte-compatible
with the Go SDK, and protects nothing. See that folder's README. It is not a
finding.
