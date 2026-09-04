import {
  CloudTrailClient,
  CreateTrailCommand,
  DeleteTrailCommand,
  DescribeTrailsCommand,
  GetTrailStatusCommand,
  LookupEventsCommand,
} from '@aws-sdk/client-cloudtrail';

import { wrapProviderError } from '../../errors.js';
import type { AwsCredentials } from '../../credentials/index.js';
import type { Audit, AuditEvent, LookupEventsOptions, TrailInfo, TrailOptions, TrailStatus } from '../types/audit.js';
import { awsClientConfig } from './auth.js';

/** AWS CloudTrail implementation of Audit. */
export class CloudTrailAudit implements Audit {
  private readonly client: CloudTrailClient;
  private readonly region: string;

  constructor(creds: AwsCredentials) {
    const cfg = awsClientConfig(creds);
    this.client = new CloudTrailClient(cfg);
    this.region = cfg.region;
  }

  /** Looks up CloudTrail events with optional filters. */
  async lookupEvents(opts?: LookupEventsOptions): Promise<AuditEvent[]> {
    const events: AuditEvent[] = [];
    let nextToken: string | undefined;

    try {
      do {
        const out = await this.client.send(
          new LookupEventsCommand({
            StartTime: opts?.startTime,
            EndTime: opts?.endTime,
            MaxResults: opts?.maxResults && opts.maxResults > 0 ? opts.maxResults : undefined,
            NextToken: nextToken,
          }),
        );
        for (const e of out.Events ?? []) {
          const resource = e.Resources?.[0];
          events.push({
            id: e.EventId ?? '',
            name: e.EventName ?? '',
            time: e.EventTime ?? new Date(0),
            username: e.Username ?? '',
            resourceId: resource?.ResourceName ?? '',
            resourceType: resource?.ResourceType ?? '',
            region: this.region,
            raw: e as unknown as Record<string, unknown>,
          });
        }
        nextToken = out.NextToken;
      } while (nextToken);
    } catch (err) {
      wrapProviderError('aws', 'lookupEvents', err);
    }

    return events;
  }

  /** Creates a new CloudTrail trail. */
  async createTrail(name: string, opts: TrailOptions): Promise<void> {
    try {
      await this.client.send(
        new CreateTrailCommand({
          Name: name,
          S3BucketName: opts.s3BucketName,
          IsMultiRegionTrail: opts.isMultiRegion ? true : undefined,
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'createTrail', err);
    }
  }

  /** Deletes a CloudTrail trail by name. */
  async deleteTrail(name: string): Promise<void> {
    try {
      await this.client.send(new DeleteTrailCommand({ Name: name }));
    } catch (err) {
      wrapProviderError('aws', 'deleteTrail', err);
    }
  }

  /** Lists all CloudTrail trails. */
  async listTrails(): Promise<TrailInfo[]> {
    try {
      const out = await this.client.send(new DescribeTrailsCommand({}));
      return (out.trailList ?? []).map((t) => ({
        name: t.Name ?? '',
        s3BucketName: t.S3BucketName ?? '',
        isMultiRegion: t.IsMultiRegionTrail ?? false,
      }));
    } catch (err) {
      wrapProviderError('aws', 'listTrails', err);
    }
  }

  /** Retrieves the delivery status of a CloudTrail trail. */
  async getTrailStatus(name: string): Promise<TrailStatus> {
    try {
      const out = await this.client.send(new GetTrailStatusCommand({ Name: name }));
      return {
        isLogging: out.IsLogging ?? false,
        latestDeliveryTime: out.LatestDeliveryTime ?? new Date(0),
      };
    } catch (err) {
      wrapProviderError('aws', 'getTrailStatus', err);
    }
  }
}
