import { AuditClient } from 'oci-audit';
import type { OciCredentials } from '../../credentials/index.js';
import { UnsupportedError, wrapProviderError } from '../../errors.js';
import type { Audit, AuditEvent, LookupEventsOptions, TrailInfo, TrailOptions, TrailStatus } from '../types/audit.js';
import { ociAuthProvider } from './auth.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** OCI Audit Service implementation of Audit. */
export class OciAudit implements Audit {
  private readonly client: AuditClient;
  private readonly compartment: string;

  constructor(creds: OciCredentials, compartment: string) {
    this.client = new AuditClient({ authenticationDetailsProvider: ociAuthProvider(creds) });
    if (creds.region) this.client.regionId = creds.region;
    this.compartment = compartment || creds.compartmentOcid || '';
  }

  /** Retrieves audit events from the OCI Audit Service. */
  async lookupEvents(opts?: LookupEventsOptions): Promise<AuditEvent[]> {
    const now = Date.now();
    const startTime = opts?.startTime ?? new Date(now - DEFAULT_WINDOW_MS);
    const endTime = opts?.endTime ?? new Date(now);

    const results: AuditEvent[] = [];
    let page: string | undefined;

    try {
      do {
        const resp = await this.client.listEvents({
          compartmentId: this.compartment,
          startTime,
          endTime,
          page,
        });
        for (const e of resp.items) {
          results.push({
            id: e.eventId ?? '',
            name: e.data?.eventName ?? '',
            time: e.eventTime ?? new Date(0),
            username: e.data?.identity?.principalName ?? '',
            resourceId: e.data?.resourceId ?? '',
            resourceType: '',
            region: '',
            raw: e as unknown as Record<string, unknown>,
          });
        }
        page = resp.opcNextPage;
      } while (page);
    } catch (err) {
      wrapProviderError('oci', 'lookupEvents', err);
    }

    return results;
  }

  /** Unsupported: OCI Audit is always-on and does not support trail creation via API. */
  async createTrail(_name: string, _opts: TrailOptions): Promise<void> {
    throw new UnsupportedError(
      'oci',
      'createTrail',
      'OCI Audit is always-on and does not support trail creation via API.',
      '',
    );
  }

  /** Unsupported: OCI Audit is always-on and does not support trail deletion. */
  async deleteTrail(_name: string): Promise<void> {
    throw new UnsupportedError('oci', 'deleteTrail', 'OCI Audit is always-on and does not support trail deletion.', '');
  }

  /** OCI Audit has no configurable trails; always returns an empty list. */
  async listTrails(): Promise<TrailInfo[]> {
    return [];
  }

  /** Unsupported: OCI Audit has no trail status concept. */
  async getTrailStatus(_name: string): Promise<TrailStatus> {
    throw new UnsupportedError(
      'oci',
      'getTrailStatus',
      'OCI Audit has no trail status concept. Audit events are always captured automatically.',
      '',
    );
  }
}
