import { Logging, type Entry } from '@google-cloud/logging';

import { UnsupportedError, wrapProviderError } from '../../errors.js';
import type { GcpCredentials } from '../../credentials/index.js';
import type {
  AlarmInfo,
  AlarmOptions,
  GetLogsOptions,
  GetMetricsOptions,
  LogEvent,
  Monitoring,
  MetricDatapoint,
  MetricDatum,
} from '../types/monitoring.js';
import { gcpClientConfig } from './auth.js';

function metricsUnsupported(op: string): UnsupportedError {
  return new UnsupportedError(
    'gcp',
    op,
    'Cloud Monitoring custom metrics are not wired in this adapter.',
    'Use the Cloud Monitoring API (monitoring/apiv3) directly.',
  );
}

function alarmUnsupported(op: string): UnsupportedError {
  return new UnsupportedError(
    'gcp',
    op,
    'Cloud Monitoring alert policies are not wired in this adapter.',
    'Use the Cloud Monitoring API (monitoring/apiv3) directly.',
  );
}

function toFilterTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function entryTimestamp(entry: Entry): Date {
  const ts = entry.metadata.timestamp;
  if (ts instanceof Date) return ts;
  if (typeof ts === 'string') return new Date(ts);
  if (ts && typeof ts === 'object' && 'seconds' in ts) {
    const seconds = Number(ts.seconds ?? 0);
    const nanos = Number(ts.nanos ?? 0);
    return new Date(seconds * 1000 + nanos / 1e6);
  }
  return new Date();
}

/** GCP Cloud Logging backed monitoring; Cloud Monitoring metrics and alarms are not wired. */
export class CloudMonitoring implements Monitoring {
  private readonly logging: Logging;
  private readonly projectId: string;

  constructor(creds: GcpCredentials) {
    this.logging = new Logging(gcpClientConfig(creds));
    this.projectId = creds.projectId;
  }

  async putMetrics(_namespace: string, _metrics: MetricDatum[]): Promise<void> {
    throw metricsUnsupported('putMetrics');
  }

  async getMetrics(_namespace: string, _metricName: string, _opts?: GetMetricsOptions): Promise<MetricDatapoint[]> {
    throw metricsUnsupported('getMetrics');
  }

  async createAlarm(_opts: AlarmOptions): Promise<void> {
    throw alarmUnsupported('createAlarm');
  }

  async deleteAlarm(_name: string): Promise<void> {
    throw alarmUnsupported('deleteAlarm');
  }

  async listAlarms(): Promise<AlarmInfo[]> {
    throw alarmUnsupported('listAlarms');
  }

  /** No-op: Cloud Logging creates logs implicitly on first write. */
  async createLogGroup(_name: string): Promise<void> {}

  async deleteLogGroup(name: string): Promise<void> {
    try {
      await this.logging.log(name).delete();
    } catch (err) {
      wrapProviderError('gcp', 'DeleteLogGroup', err);
    }
  }

  async putLogs(logGroup: string, _logStream: string, events: LogEvent[]): Promise<void> {
    const logger = this.logging.log(logGroup);
    const entries = events.map((e) => logger.entry({ timestamp: e.timestamp }, e.message));
    try {
      await logger.write(entries);
    } catch (err) {
      wrapProviderError('gcp', 'PutLogs', err);
    }
  }

  async getLogs(logGroup: string, _logStream: string, opts?: GetLogsOptions): Promise<LogEvent[]> {
    let filter = `logName="projects/${this.projectId}/logs/${logGroup}"`;
    if (opts?.startTime) filter += ` AND timestamp>="${toFilterTime(opts.startTime)}"`;
    if (opts?.endTime) filter += ` AND timestamp<="${toFilterTime(opts.endTime)}"`;

    try {
      const [entries] = await this.logging.getEntries({
        filter,
        orderBy: 'timestamp desc',
        maxResults: opts?.limit && opts.limit > 0 ? opts.limit : undefined,
      });
      return entries.map((e) => ({ timestamp: entryTimestamp(e), message: String(e.data) }));
    } catch (err) {
      return wrapProviderError('gcp', 'GetLogs', err);
    }
  }
}
