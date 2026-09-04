import {
  CloudFrontClient,
  CreateDistributionCommand,
  CreateInvalidationCommand,
  DeleteDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  GetInvalidationCommand,
  ListDistributionsCommand,
  ListInvalidationsCommand,
  UpdateDistributionCommand,
  type Distribution,
  type DistributionConfig,
  type DistributionSummary,
  type GetDistributionConfigCommandOutput,
} from '@aws-sdk/client-cloudfront';

import { NotFoundError, wrapProviderError } from '../../errors.js';
import type { AwsCredentials } from '../../credentials/index.js';
import type { Cdn, CdnDistribution, CdnDistributionOptions, CdnInvalidation } from '../types/cdn.js';
import { awsClientConfig } from './auth.js';

const MANAGED_CACHING_OPTIMIZED_POLICY_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const ORIGIN_ID = 'fc-default-origin';

function callerReference(): string {
  return `fc-${process.hrtime.bigint()}`;
}

function buildDistributionConfig(opts: CdnDistributionOptions, callerRef: string): DistributionConfig {
  const cfg: DistributionConfig = {
    CallerReference: callerRef,
    Comment: opts.comment ?? '',
    Enabled: opts.enabled ?? false,
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: ORIGIN_ID,
          DomainName: opts.originDomain,
          CustomOriginConfig: {
            HTTPPort: 80,
            HTTPSPort: 443,
            OriginProtocolPolicy: 'https-only',
          },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: ORIGIN_ID,
      ViewerProtocolPolicy: 'redirect-to-https',
      CachePolicyId: MANAGED_CACHING_OPTIMIZED_POLICY_ID,
    },
  };
  if (opts.defaultRootObject) cfg.DefaultRootObject = opts.defaultRootObject;
  return cfg;
}

function toCdnDistribution(d: Distribution): CdnDistribution {
  const out: CdnDistribution = {
    id: d.Id ?? '',
    domainName: d.DomainName ?? '',
    originDomain: '',
    status: d.Status ?? '',
    enabled: false,
    comment: '',
  };
  const cfg = d.DistributionConfig;
  if (cfg) {
    out.enabled = cfg.Enabled ?? false;
    out.comment = cfg.Comment ?? '';
    if (cfg.Origins?.Items?.length) {
      out.originDomain = cfg.Origins.Items[0]!.DomainName ?? '';
    }
  }
  return out;
}

function summaryToCdnDistribution(s: DistributionSummary): CdnDistribution {
  return {
    id: s.Id ?? '',
    domainName: s.DomainName ?? '',
    originDomain: s.Origins?.Items?.[0]?.DomainName ?? '',
    status: s.Status ?? '',
    enabled: s.Enabled ?? false,
    comment: s.Comment ?? '',
  };
}

/** AWS CloudFront implementation of the unified CDN interface. */
export class CloudFrontCdn implements Cdn {
  private readonly client: CloudFrontClient;

  constructor(creds: AwsCredentials, region?: string) {
    this.client = new CloudFrontClient(awsClientConfig(creds, region));
  }

  private async getDistributionConfig(id: string, op: string): Promise<GetDistributionConfigCommandOutput> {
    try {
      return await this.client.send(new GetDistributionConfigCommand({ Id: id }));
    } catch (err) {
      return wrapProviderError('aws', op, err);
    }
  }

  async createDistribution(opts: CdnDistributionOptions): Promise<CdnDistribution> {
    try {
      const out = await this.client.send(
        new CreateDistributionCommand({ DistributionConfig: buildDistributionConfig(opts, callerReference()) }),
      );
      return toCdnDistribution(out.Distribution!);
    } catch (err) {
      return wrapProviderError('aws', 'createDistribution', err);
    }
  }

  async getDistribution(id: string): Promise<CdnDistribution> {
    try {
      const out = await this.client.send(new GetDistributionCommand({ Id: id }));
      return toCdnDistribution(out.Distribution!);
    } catch (err) {
      return wrapProviderError('aws', 'getDistribution', err);
    }
  }

  async listDistributions(): Promise<CdnDistribution[]> {
    const results: CdnDistribution[] = [];
    let marker: string | undefined;
    try {
      for (;;) {
        const out = await this.client.send(new ListDistributionsCommand({ Marker: marker }));
        const list = out.DistributionList;
        if (list) {
          for (const s of list.Items ?? []) results.push(summaryToCdnDistribution(s));
          if (list.IsTruncated) {
            marker = list.NextMarker;
            continue;
          }
        }
        break;
      }
    } catch (err) {
      return wrapProviderError('aws', 'listDistributions', err);
    }
    return results;
  }

  async updateDistribution(id: string, opts: CdnDistributionOptions): Promise<CdnDistribution> {
    const current = await this.getDistributionConfig(id, 'updateDistribution');
    const callerRef = current.DistributionConfig?.CallerReference ?? callerReference();
    const cfg = buildDistributionConfig(opts, callerRef);
    try {
      const out = await this.client.send(
        new UpdateDistributionCommand({ Id: id, IfMatch: current.ETag, DistributionConfig: cfg }),
      );
      return toCdnDistribution(out.Distribution!);
    } catch (err) {
      return wrapProviderError('aws', 'updateDistribution', err);
    }
  }

  async deleteDistribution(id: string): Promise<void> {
    const current = await this.getDistributionConfig(id, 'deleteDistribution');
    try {
      await this.client.send(new DeleteDistributionCommand({ Id: id, IfMatch: current.ETag }));
    } catch (err) {
      wrapProviderError('aws', 'deleteDistribution', err);
    }
  }

  private async setEnabled(id: string, enabled: boolean, op: string): Promise<void> {
    const current = await this.getDistributionConfig(id, op);
    const cfg = current.DistributionConfig;
    if (!cfg) throw new NotFoundError(`aws: ${op}: distribution ${id} not found`);
    cfg.Enabled = enabled;
    try {
      await this.client.send(new UpdateDistributionCommand({ Id: id, IfMatch: current.ETag, DistributionConfig: cfg }));
    } catch (err) {
      wrapProviderError('aws', op, err);
    }
  }

  async enableDistribution(id: string): Promise<void> {
    return this.setEnabled(id, true, 'enableDistribution');
  }

  async disableDistribution(id: string): Promise<void> {
    return this.setEnabled(id, false, 'disableDistribution');
  }

  async createInvalidation(id: string, paths: string[]): Promise<string> {
    let invalidation;
    try {
      const out = await this.client.send(
        new CreateInvalidationCommand({
          DistributionId: id,
          InvalidationBatch: {
            CallerReference: callerReference(),
            Paths: { Quantity: paths.length, Items: paths },
          },
        }),
      );
      invalidation = out.Invalidation;
    } catch (err) {
      return wrapProviderError('aws', 'createInvalidation', err);
    }
    if (!invalidation) throw new NotFoundError(`aws: createInvalidation: distribution ${id} not found`);
    return invalidation.Id ?? '';
  }

  async getInvalidation(id: string, invalidationId: string): Promise<CdnInvalidation> {
    let invalidation;
    try {
      const out = await this.client.send(new GetInvalidationCommand({ DistributionId: id, Id: invalidationId }));
      invalidation = out.Invalidation;
    } catch (err) {
      return wrapProviderError('aws', 'getInvalidation', err);
    }
    if (!invalidation) throw new NotFoundError(`aws: getInvalidation: invalidation ${invalidationId} not found`);
    return {
      id: invalidation.Id ?? '',
      status: invalidation.Status ?? '',
      paths: invalidation.InvalidationBatch?.Paths?.Items ?? [],
      createdAt: invalidation.CreateTime ?? new Date(0),
    };
  }

  async listInvalidations(id: string): Promise<CdnInvalidation[]> {
    const results: CdnInvalidation[] = [];
    let marker: string | undefined;
    try {
      for (;;) {
        const out = await this.client.send(new ListInvalidationsCommand({ DistributionId: id, Marker: marker }));
        const list = out.InvalidationList;
        if (list) {
          for (const s of list.Items ?? []) {
            results.push({ id: s.Id ?? '', status: s.Status ?? '', paths: [], createdAt: s.CreateTime ?? new Date(0) });
          }
          if (list.IsTruncated) {
            marker = list.NextMarker;
            continue;
          }
        }
        break;
      }
    } catch (err) {
      return wrapProviderError('aws', 'listInvalidations', err);
    }
    return results;
  }
}
