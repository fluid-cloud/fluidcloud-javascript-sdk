import * as logging from 'oci-logging';
import * as loggingingestion from 'oci-loggingingestion';
import * as loggingsearch from 'oci-loggingsearch';
import * as monitoring from 'oci-monitoring';
import type { OciCredentials } from '../../credentials/index.js';
import { NotFoundError, wrapProviderError } from '../../errors.js';
import type {
  AlarmInfo,
  AlarmOptions,
  GetLogsOptions,
  GetMetricsOptions,
  LogEvent,
  MetricDatapoint,
  MetricDatum,
  Monitoring as MonitoringType,
} from '../types/monitoring.js';
import { ociAuthProvider } from './auth.js';

function alarmSeverity(statistic: string): monitoring.models.Alarm.Severity {
  switch (statistic) {
    case 'CRITICAL':
      return monitoring.models.Alarm.Severity.Critical;
    case 'ERROR':
      return monitoring.models.Alarm.Severity.Error;
    case 'INFO':
      return monitoring.models.Alarm.Severity.Info;
    default:
      return monitoring.models.Alarm.Severity.Warning;
  }
}

/** OCI Monitoring, Logging Management, Logging Ingestion and Logging Search backed monitoring. */
export class OciMonitoring implements MonitoringType {
  private readonly metricsClient: monitoring.MonitoringClient;
  private readonly loggingClient: logging.LoggingManagementClient;
  private readonly ingestClient: loggingingestion.LoggingClient;
  private readonly searchClient: loggingsearch.LogSearchClient;
  private readonly compartment: string;

  constructor(creds: OciCredentials, compartment: string) {
    this.compartment = compartment || creds.compartmentOcid || '';
    const provider = ociAuthProvider(creds);
    this.metricsClient = new monitoring.MonitoringClient({ authenticationDetailsProvider: provider });
    this.loggingClient = new logging.LoggingManagementClient({ authenticationDetailsProvider: provider });
    this.ingestClient = new loggingingestion.LoggingClient({ authenticationDetailsProvider: provider });
    this.searchClient = new loggingsearch.LogSearchClient({ authenticationDetailsProvider: provider });
    if (creds.region) {
      this.metricsClient.regionId = creds.region;
      this.loggingClient.regionId = creds.region;
      this.ingestClient.regionId = creds.region;
      this.searchClient.regionId = creds.region;
    }
  }

  async putMetrics(namespace: string, metrics: MetricDatum[]): Promise<void> {
    const metricData: monitoring.models.MetricDataDetails[] = metrics.map((md) => ({
      namespace,
      compartmentId: this.compartment,
      name: md.name,
      dimensions: md.dimensions ?? {},
      datapoints: [{ timestamp: md.timestamp ?? new Date(), value: md.value }],
    }));
    try {
      await this.metricsClient.postMetricData({ postMetricDataDetails: { metricData } });
    } catch (err) {
      wrapProviderError('oci', 'PostMetricData', err);
    }
  }

  async getMetrics(namespace: string, metricName: string, opts?: GetMetricsOptions): Promise<MetricDatapoint[]> {
    const details: monitoring.models.SummarizeMetricsDataDetails = {
      namespace,
      query: `${metricName}[60s].mean()`,
      startTime: opts?.startTime,
      endTime: opts?.endTime,
    };
    try {
      const resp = await this.metricsClient.summarizeMetricsData({
        compartmentId: this.compartment,
        summarizeMetricsDataDetails: details,
      });
      const results: MetricDatapoint[] = [];
      for (const md of resp.items ?? []) {
        for (const dp of md.aggregatedDatapoints ?? []) {
          results.push({ timestamp: dp.timestamp ?? new Date(0), value: dp.value ?? 0, unit: '' });
        }
      }
      return results;
    } catch (err) {
      return wrapProviderError('oci', 'SummarizeMetricsData', err);
    }
  }

  async createAlarm(opts: AlarmOptions): Promise<void> {
    const query = `${opts.metricName}[60s].mean() ${opts.comparisonOperator} ${opts.threshold}`;
    try {
      await this.metricsClient.createAlarm({
        createAlarmDetails: {
          displayName: opts.name,
          compartmentId: this.compartment,
          metricCompartmentId: this.compartment,
          namespace: opts.namespace,
          query,
          severity: alarmSeverity(opts.statistic),
          destinations: opts.alarmActions ?? [],
          isEnabled: true,
        },
      });
    } catch (err) {
      wrapProviderError('oci', 'CreateAlarm', err);
    }
  }

  async deleteAlarm(name: string): Promise<void> {
    let page: string | undefined;
    try {
      for (;;) {
        const resp = await this.metricsClient.listAlarms({ compartmentId: this.compartment, page });
        for (const a of resp.items ?? []) {
          if (a.displayName === name && a.id) {
            await this.metricsClient.deleteAlarm({ alarmId: a.id });
            return;
          }
        }
        if (!resp.opcNextPage) break;
        page = resp.opcNextPage;
      }
    } catch (err) {
      wrapProviderError('oci', 'ListAlarms(DeleteAlarm)', err);
    }
    throw new NotFoundError();
  }

  async listAlarms(): Promise<AlarmInfo[]> {
    const results: AlarmInfo[] = [];
    let page: string | undefined;
    try {
      for (;;) {
        const resp = await this.metricsClient.listAlarms({ compartmentId: this.compartment, page });
        for (const a of resp.items ?? []) {
          results.push({ name: a.displayName ?? '', state: a.lifecycleState ?? '', metricName: '', threshold: 0 });
        }
        if (!resp.opcNextPage) break;
        page = resp.opcNextPage;
      }
    } catch (err) {
      return wrapProviderError('oci', 'ListAlarms', err);
    }
    return results;
  }

  async createLogGroup(name: string): Promise<void> {
    try {
      await this.loggingClient.createLogGroup({
        createLogGroupDetails: { compartmentId: this.compartment, displayName: name },
      });
    } catch (err) {
      wrapProviderError('oci', 'CreateLogGroup', err);
    }
  }

  async deleteLogGroup(name: string): Promise<void> {
    const groupId = await this.findLogGroupID(name);
    try {
      await this.loggingClient.deleteLogGroup({ logGroupId: groupId });
    } catch (err) {
      wrapProviderError('oci', 'DeleteLogGroup', err);
    }
  }

  /** Resolves a log group display name to its OCID. */
  private async findLogGroupID(name: string): Promise<string> {
    let page: string | undefined;
    try {
      for (;;) {
        const resp = await this.loggingClient.listLogGroups({ compartmentId: this.compartment, page });
        for (const lg of resp.items ?? []) {
          if (lg.displayName === name && lg.id) return lg.id;
        }
        if (!resp.opcNextPage) break;
        page = resp.opcNextPage;
      }
    } catch (err) {
      wrapProviderError('oci', 'ListLogGroups', err);
    }
    throw new NotFoundError(`log group "${name}"`);
  }

  /** Resolves a log display name within a log group to its OCID. */
  private async findLogID(logGroup: string, logStream: string): Promise<string> {
    const groupId = await this.findLogGroupID(logGroup);
    let page: string | undefined;
    try {
      for (;;) {
        const resp = await this.loggingClient.listLogs({ logGroupId: groupId, page });
        for (const l of resp.items ?? []) {
          if (l.displayName === logStream && l.id) return l.id;
        }
        if (!resp.opcNextPage) break;
        page = resp.opcNextPage;
      }
    } catch (err) {
      wrapProviderError('oci', 'ListLogs', err);
    }
    throw new NotFoundError(`log "${logStream}" in group "${logGroup}"`);
  }

  async putLogs(logGroup: string, logStream: string, events: LogEvent[]): Promise<void> {
    // Ingestion addresses a Log by OCID, not by log-group name, so the
    // group/stream pair has to be resolved before anything can be written.
    const logId = await this.findLogID(logGroup, logStream);

    const now = new Date();
    const entries: loggingingestion.models.LogEntry[] = events.map((ev, i) => ({
      id: `${logGroup}-${logStream}-${i}`,
      data: ev.message,
      time: ev.timestamp,
    }));

    try {
      await this.ingestClient.putLogs({
        logId,
        putLogsDetails: {
          specversion: '1.0',
          logEntryBatches: [{ entries, source: logStream, type: logGroup, defaultlogentrytime: now }],
        },
      });
    } catch (err) {
      wrapProviderError('oci', 'PutLogs', err);
    }
  }

  async getLogs(logGroup: string, logStream: string, opts?: GetLogsOptions): Promise<LogEvent[]> {
    const startTime = opts?.startTime ?? new Date(Date.now() - 60 * 60 * 1000);
    const endTime = opts?.endTime ?? new Date();
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 100;
    const searchQuery = `search "${this.compartment}/${logGroup}/${logStream}" | limit ${limit}`;

    try {
      const resp = await this.searchClient.searchLogs({
        searchLogsDetails: { timeStart: startTime, timeEnd: endTime, searchQuery, isReturnFieldInfo: false },
      });
      return (resp.searchResponse.results ?? [])
        .filter((r) => r.data !== undefined && r.data !== null)
        .map((r) => ({ timestamp: logEntryTime(r.data), message: String(r.data) }));
    } catch (err) {
      return wrapProviderError('oci', 'SearchLogs', err);
    }
  }
}

/**
 * Pulls a log entry's own timestamp out of the search result, checking the
 * `datetime`, `time` and `timestamp` keys and accepting RFC3339 strings or
 * epoch-millis numbers. `LogEvent.timestamp` is typed as a non-optional
 * Date, so this falls back to the epoch (new Date(0)) as the zero-value
 * sentinel when the payload carries no recognizable timestamp, rather than
 * returning undefined.
 */
function logEntryTime(data: unknown): Date {
  if (typeof data !== 'object' || data === null) return new Date(0);
  const fields = data as Record<string, unknown>;
  for (const key of ['datetime', 'time', 'timestamp']) {
    const v = fields[key];
    if (typeof v === 'string') {
      const parsed = new Date(v);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    } else if (typeof v === 'number') {
      return new Date(v);
    }
  }
  return new Date(0);
}
