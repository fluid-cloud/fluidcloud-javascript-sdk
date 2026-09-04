# =============================================================================
# FluidCloud JS SDK — Makefile
# =============================================================================
#
# USAGE:
#   make e2e API_KEY=fc_xxx ENTITY_ID_AWS=entity-123 TEST_BUCKET=my-bucket
#
# REQUIRED (an API key plus at least one entity ID):
#   API_KEY              — FluidCloud API key (User Settings > API Keys)
#   ENTITY_ID_AWS        — AWS cloud account entity ID   (skips AWS if empty)
#   ENTITY_ID_AZURE      — Azure cloud account entity ID (skips Azure if empty)
#   ENTITY_ID_GCP        — GCP cloud account entity ID   (skips GCP if empty)
#   ENTITY_ID_OCI        — OCI cloud account entity ID   (skips OCI if empty)
#
# OPTIONAL (per provider; suites skip with a clear reason when absent):
#   SERVER_URL, TEST_BUCKET, OCI_TEST_BUCKET, GCP_TEST_BUCKET, AZURE_TEST_CONTAINER
#   AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_ACCOUNT_KEY, AZURE_KEY_VAULT,
#   AZURE_APPCONFIG_ENDPOINT, AZURE_SERVICEBUS_NAMESPACE, AZURE_RESOURCE_GROUP
#   OCI_NAMESPACE, OCI_COMPARTMENT, OCI_VAULT_OCID, OCI_KEY_OCID
#   REDIS_ENDPOINT, REDIS_PASSWORD, REDIS_TLS
#   SEARCH_ENDPOINT, SEARCH_API_KEY, SEARCH_USERNAME, SEARCH_PASSWORD
# =============================================================================

SERVER_URL ?= https://app.fluidcloud.com

.PHONY: all deps typecheck test build e2e clean help

all: deps typecheck test build

help:
	@echo ""
	@echo "FluidCloud JS SDK — targets:"
	@echo "  make deps        Install dependencies (bun)"
	@echo "  make typecheck   tsc --noEmit across the whole project"
	@echo "  make test        Unit tests (mocked, no network, no credentials)"
	@echo "  make build       Bundle to dist/ (ESM + CJS + .d.ts)"
	@echo "  make e2e         Live tests against real cloud accounts"
	@echo "  make clean       Remove dist/ and test artifacts"
	@echo ""
	@echo "E2E example:"
	@echo "  make e2e API_KEY=fc_xxx ENTITY_ID_AWS=entity-123 TEST_BUCKET=my-bucket"
	@echo ""

deps:
	bun install

typecheck:
	npx tsc --noEmit

test:
	npx vitest run

build:
	npx tsup

clean:
	rm -rf dist TEST_RESULTS.md test_results.json

e2e:
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo " FluidCloud JS SDK — E2E Tests"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo " Server:  $(SERVER_URL)"
	@echo " API Key: $(if $(API_KEY),***set***,NOT SET)"
	@echo " Entities:"
	@echo "   AWS:   $(if $(ENTITY_ID_AWS),$(ENTITY_ID_AWS),— not set (skipping))"
	@echo "   Azure: $(if $(ENTITY_ID_AZURE),$(ENTITY_ID_AZURE),— not set (skipping))"
	@echo "   GCP:   $(if $(ENTITY_ID_GCP),$(ENTITY_ID_GCP),— not set (skipping))"
	@echo "   OCI:   $(if $(ENTITY_ID_OCI),$(ENTITY_ID_OCI),— not set (skipping))"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@SERVER_URL=$(SERVER_URL) npx vitest run --config vitest.e2e.config.ts; \
	if [ -f TEST_RESULTS.md ]; then echo ""; cat TEST_RESULTS.md; fi; \
	exit 0
