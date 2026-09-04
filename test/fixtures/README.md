# Test fixtures

## `insecure-test-keypair.json` and `go-envelope.json`

These two files together prove that this SDK's envelope decryption is
byte-compatible with the Go SDK's envelope encryption.

`go-envelope.json` was produced by running the **Go** SDK's
`credentials.EncryptEnvelope` against the public key in
`insecure-test-keypair.json`. `test/envelope.test.ts` decrypts it here in
TypeScript and asserts the plaintext matches. If the two implementations ever
drift — a different GCM tag placement, a different OAEP hash, a different base64
convention — that test fails.

**The RSA private key in `insecure-test-keypair.json` is deliberately public.**
It was generated for this fixture and nothing else:

- it has never been used against any FluidCloud server, cloud provider or service
- it protects nothing — the envelope it decrypts contains AWS's published
  `AKIAIOSFODNN7EXAMPLE` documentation credentials
- it must never be reused anywhere for any purpose

The SDK itself never reads these files. It generates a fresh ephemeral RSA-2048
key pair per credential fetch, in memory, and discards it with the client.
