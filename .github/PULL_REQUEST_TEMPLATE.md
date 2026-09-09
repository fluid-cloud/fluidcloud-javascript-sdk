## What this changes

<!-- One or two sentences. What behaviour is different after this merges? -->

## Why

<!-- The problem, not the patch. Link an issue if there is one. -->

## Provider impact

<!-- Tick every provider whose behaviour changes. -->

- [ ] AWS
- [ ] Azure
- [ ] GCP
- [ ] OCI
- [ ] None — docs, tooling or tests only

## Checklist

- [ ] `bun run lint`, `bun run typecheck`, `bun run test` and `bun run build` pass locally
- [ ] Tests cover the change, table-driven where the cases are parallel
- [ ] `CHANGELOG.md` has an entry under **Unreleased**
- [ ] A new provider dependency is an **optional peer dependency**, not a runtime one
- [ ] No credentials, account identifiers or customer data in the diff

## Behaviour change?

<!-- If this alters behaviour rather than fixing a bug — a different return
shape, a different error, a capability that starts or stops working — say so
here. Keeping the SDKs in step is the maintainers' job; you only need to flag it. -->
