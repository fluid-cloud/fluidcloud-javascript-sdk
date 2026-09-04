import { MonitorClient } from '@azure/arm-monitor';

import { UnsupportedError, wrapProviderError } from '../../errors.js';
import type { AzureCredentials } from '../../credentials/index.js';
import type { Audit, AuditEvent, LookupEventsOptions, TrailInfo, TrailOptions, TrailStatus } from '../types/audit.js';
import { azureCredential } from './auth.js';

/** Azure Monitor Activity Log implementation of Audit. */
export class ActivityLogAudit implements Audit {
  private readonly client: MonitorClient;

  constructor(creds: AzureCredentials) {
    this.client = new MonitorClient(azureCredential(creds), creds.subscriptionId);
  }

  /** Queries the Azure Activity Log for audit events. */
  async lookupEvents(opts?: LookupEventsOptions): Promise<AuditEvent[]> {
    const filter =
      opts?.startTime && opts?.endTime
        ? `eventTimestamp ge '${opts.startTime.toISOString().replace(/\.\d{3}Z$/, 'Z')}' and eventTimestamp le '${opts.endTime.toISOString().replace(/\.\d{3}Z$/, 'Z')}'`
        : "eventTimestamp ge '1970-01-01T00:00:00Z'";

    const result: AuditEvent[] = [];
    try {
      for await (const e of this.client.activityLogs.list(filter)) {
        result.push({
          id: e.eventDataId ?? '',
          name: e.operationName?.value ?? '',
          time: e.eventTimestamp ?? new Date(0),
          username: e.caller ?? '',
          resourceId: e.resourceId ?? '',
          resourceType: '',
          region: '',
          raw: e as unknown as Record<string, unknown>,
        });
      }
    } catch (err) {
      wrapProviderError('azure', 'lookupEvents', err);
    }
    return result;
  }

  /** Unsupported: Azure Activity Log is always-on and cannot be configured via API. */
  async createTrail(_name: string, _opts: TrailOptions): Promise<void> {
    throw new UnsupportedError(
      'azure',
      'createTrail',
      'Azure Activity Log is always-on and cannot be configured via API.',
      'Use Diagnostic Settings in the Azure portal to archive logs.',
    );
  }

  /** Unsupported: Azure Activity Log is always-on and cannot be deleted. */
  async deleteTrail(_name: string): Promise<void> {
    throw new UnsupportedError('azure', 'deleteTrail', 'Azure Activity Log is always-on and cannot be deleted.', '');
  }

  /** Azure Activity Log has no configurable trails; always returns an empty list. */
  async listTrails(): Promise<TrailInfo[]> {
    return [];
  }

  /** Unsupported: Azure Activity Log has no trail status concept. */
  async getTrailStatus(_name: string): Promise<TrailStatus> {
    throw new UnsupportedError(
      'azure',
      'getTrailStatus',
      'Azure Activity Log has no trail status concept.',
      'Use the Azure Monitor portal to view log delivery health.',
    );
  }
}
