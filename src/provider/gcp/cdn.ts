import { createHash } from 'node:crypto';

import { BackendBucketsClient, GlobalOperationsClient, type protos } from '@google-cloud/compute';

import { NotFoundError, UnsupportedError, wrapProviderError } from '../../errors.js';
import type { GcpCredentials } from '../../credentials/index.js';
import type { Cdn, CdnDistribution, CdnDistributionOptions, CdnInvalidation } from '../types/cdn.js';
import { gcpClientConfig } from './auth.js';

type BackendBucket = protos.google.cloud.compute.v1.IBackendBucket;
type Operation = protos.google.cloud.compute.v1.IOperation;

const INVALIDATION_MESSAGE =
  'Cloud CDN cache invalidation runs against a URL map / load balancer, which this backend-bucket model does not provision.';
const INVALIDATION_ALTERNATIVE = 'Invalidate via urlMaps.invalidateCache on the fronting load balancer.';

function invalidationUnsupported(op: string): UnsupportedError {
  return new UnsupportedError('gcp', op, INVALIDATION_MESSAGE, INVALIDATION_ALTERNATIVE);
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: number } | undefined)?.code;
  return code === 5 || code === 404;
}

function toCdnDistribution(bb: BackendBucket): CdnDistribution {
  return {
    id: bb.name ?? '',
    domainName: '',
    originDomain: bb.bucketName ?? '',
    status: 'active',
    enabled: bb.enableCdn ?? false,
    comment: bb.description ?? '',
  };
}

/** GCP Cloud CDN implementation; a distribution is a CDN-enabled Compute backend bucket. */
export class CloudCdn implements Cdn {
  private readonly client: BackendBucketsClient;
  private readonly operations: GlobalOperationsClient;
  private readonly projectId: string;

  constructor(creds: GcpCredentials) {
    const cfg = gcpClientConfig(creds) as unknown as ConstructorParameters<typeof BackendBucketsClient>[0];
    this.client = new BackendBucketsClient(cfg);
    this.operations = new GlobalOperationsClient(cfg);
    this.projectId = creds.projectId;
  }

  private async waitForOperation(op: Operation | undefined): Promise<void> {
    let current = op;
    for (let i = 0; current?.name && current.status !== 'DONE' && i < 60; i++) {
      const [result] = await this.operations.wait({ operation: current.name, project: this.projectId });
      current = result;
    }
    const errors = current?.error?.errors;
    if (errors?.length) {
      throw new Error(errors.map((e) => e.message).filter(Boolean).join('; '));
    }
  }

  async createDistribution(opts: CdnDistributionOptions): Promise<CdnDistribution> {
    const name = `cdn-${shortHash(opts.originDomain)}`;
    try {
      const [, op] = await this.client.insert({
        project: this.projectId,
        backendBucketResource: {
          name,
          bucketName: opts.originDomain,
          enableCdn: opts.enabled ?? false,
          description: opts.comment ?? '',
        },
      });
      await this.waitForOperation(op);
    } catch (err) {
      return wrapProviderError('gcp', 'createDistribution', err);
    }
    return this.getDistribution(name);
  }

  async getDistribution(id: string): Promise<CdnDistribution> {
    try {
      const [bb] = await this.client.get({ project: this.projectId, backendBucket: id });
      return toCdnDistribution(bb);
    } catch (err) {
      if (isNotFound(err)) throw new NotFoundError(`gcp: getDistribution: backend bucket ${id} not found`);
      return wrapProviderError('gcp', 'getDistribution', err);
    }
  }

  async listDistributions(): Promise<CdnDistribution[]> {
    const results: CdnDistribution[] = [];
    try {
      for await (const bb of this.client.listAsync({ project: this.projectId })) {
        results.push(toCdnDistribution(bb));
      }
    } catch (err) {
      return wrapProviderError('gcp', 'listDistributions', err);
    }
    return results;
  }

  private async patch(id: string, resource: BackendBucket, op: string): Promise<void> {
    try {
      const [, operation] = await this.client.patch({
        project: this.projectId,
        backendBucket: id,
        backendBucketResource: resource,
      });
      await this.waitForOperation(operation);
    } catch (err) {
      wrapProviderError('gcp', op, err);
    }
  }

  async updateDistribution(id: string, opts: CdnDistributionOptions): Promise<CdnDistribution> {
    await this.patch(id, { enableCdn: opts.enabled ?? false, description: opts.comment ?? '' }, 'updateDistribution');
    return this.getDistribution(id);
  }

  async deleteDistribution(id: string): Promise<void> {
    try {
      const [, op] = await this.client.delete({ project: this.projectId, backendBucket: id });
      await this.waitForOperation(op);
    } catch (err) {
      wrapProviderError('gcp', 'deleteDistribution', err);
    }
  }

  async enableDistribution(id: string): Promise<void> {
    return this.patch(id, { enableCdn: true }, 'enableDistribution');
  }

  async disableDistribution(id: string): Promise<void> {
    return this.patch(id, { enableCdn: false }, 'disableDistribution');
  }

  async createInvalidation(_id: string, _paths: string[]): Promise<string> {
    throw invalidationUnsupported('createInvalidation');
  }

  async getInvalidation(_id: string, _invalidationId: string): Promise<CdnInvalidation> {
    throw invalidationUnsupported('getInvalidation');
  }

  async listInvalidations(_id: string): Promise<CdnInvalidation[]> {
    throw invalidationUnsupported('listInvalidations');
  }
}
