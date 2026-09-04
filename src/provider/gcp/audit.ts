import { Logging } from '@google-cloud/logging';

import { UnsupportedError, wrapProviderError } from '../../errors.js';
import type { GcpCredentials } from '../../credentials/index.js';
import type { Audit, AuditEvent, LookupEventsOptions, TrailInfo, TrailOptions, TrailStatus } from '../types/audit.js';
import { gcpClientConfig } from './auth.js';

function trailUnsupported(op: string): UnsupportedError {
  return new UnsupportedError(
    'gcp',
    op,
    'GCP audit logging is always-on and project-wide; there are no trails.',
    'Read events with lookupEvents; configure sinks via Cloud Logging if export is needed.',
  );
}

/** GCP Cloud Audit Logs (via Cloud Logging) implementation of Audit. */
export class CloudAudit implements Audit {
  private readonly client: Logging;

  constructor(creds: GcpCredentials) {
    this.client = new Logging(gcpClientConfig(creds));
  }

  /** Looks up Cloud Audit Log entries with optional filters. */
  async lookupEvents(opts?: LookupEventsOptions): Promise<AuditEvent[]> {
    let filter = 'logName:"cloudaudit.googleapis.com"';
    let max = 100;
    if (opts?.startTime) filter += ` AND timestamp>="${opts.startTime.toISOString()}"`;
    if (opts?.endTime) filter += ` AND timestamp<="${opts.endTime.toISOString()}"`;
    if (opts?.resourceType) filter += ` AND resource.type="${opts.resourceType}"`;
    if (opts?.maxResults && opts.maxResults > 0) max = opts.maxResults;

    try {
      const [entries] = await this.client.getEntries({ filter, orderBy: 'timestamp desc', maxResults: max });
      return entries.slice(0, max).map((e) => ({
        id: e.metadata.insertId ?? '',
        name: e.metadata.logName ?? '',
        time: (e.metadata.timestamp as Date | undefined) ?? new Date(0),
        username: '',
        resourceId: '',
        resourceType: e.metadata.resource?.type ?? '',
        region: e.metadata.resource?.labels?.location ?? '',
        raw: e as unknown as Record<string, unknown>,
      }));
    } catch (err) {
      wrapProviderError('gcp', 'lookupEvents', err);
    }
  }

  /** Unsupported: GCP audit logging is always-on and project-wide; there are no trails. */
  async createTrail(_name: string, _opts: TrailOptions): Promise<void> {
    throw trailUnsupported('createTrail');
  }

  /** Unsupported: GCP audit logging is always-on and project-wide; there are no trails. */
  async deleteTrail(_name: string): Promise<void> {
    throw trailUnsupported('deleteTrail');
  }

  /** Unsupported: GCP audit logging is always-on and project-wide; there are no trails. */
  async listTrails(): Promise<TrailInfo[]> {
    throw trailUnsupported('listTrails');
  }

  /** Unsupported: GCP audit logging is always-on and project-wide; there are no trails. */
  async getTrailStatus(_name: string): Promise<TrailStatus> {
    throw trailUnsupported('getTrailStatus');
  }
}
