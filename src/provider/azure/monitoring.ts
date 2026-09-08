import {
  KnownAggregationTypeEnum,
  KnownCriterionType,
  KnownOdatatype,
  KnownOperator,
  MonitorClient,
} from '@azure/arm-monitor';
import { OperationalInsightsManagementClient } from '@azure/arm-operationalinsights';
import type { ClientSecretCredential } from '@azure/identity';
import { LogsIngestionClient } from '@azure/monitor-ingestion';
import { type AggregationType, LogsQueryClient, MetricsQueryClient } from '@azure/monitor-query';
import type { AzureCredentials } from '../../credentials/index.js';
import { UnsupportedError, wrapProviderError } from '../../errors.js';
import type {
  AlarmInfo,
  AlarmOptions,
  GetLogsOptions,
  GetMetricsOptions,
  LogEvent,
  MetricDatapoint,
  MetricDatum,
  Monitoring,
} from '../types/monitoring.js';
import { azureCredential } from './auth.js';

/** Azure Monitor Query/Ingestion and Log Analytics backed monitoring. */
export class AzureMonitoring implements Monitoring {
  private readonly subscriptionId: string;
  private readonly resourceGroup: string;
  private readonly workspaceId: string;
  private readonly dataCollectionEndpoint: string;
  private readonly credential: ClientSecretCredential;

  constructor(
    creds: AzureCredentials,
    resourceGroup: string,
    logAnalyticsWorkspaceId: string,
    dataCollectionEndpoint: string,
  ) {
    this.subscriptionId = creds.subscriptionId;
    this.resourceGroup = resourceGroup;
    this.workspaceId = logAnalyticsWorkspaceId;
    this.dataCollectionEndpoint = dataCollectionEndpoint;
    this.credential = azureCredential(creds);
  }

  async putMetrics(namespace: string, metrics: MetricDatum[]): Promise<void> {
    if (!this.dataCollectionEndpoint) {
      throw new UnsupportedError(
        'azure',
        'putMetrics',
        'dataCollectionEndpoint is required for Azure custom metrics',
        'Provide a Data Collection Endpoint URL',
      );
    }

    const client = new LogsIngestionClient(this.dataCollectionEndpoint, this.credential);
    const entries = metrics.map((md) => ({
      time: (md.timestamp ?? new Date()).toISOString(),
      namespace,
      name: md.name,
      value: md.value,
      unit: md.unit,
      dimensions: md.dimensions,
    }));

    try {
      await client.upload(namespace, `Custom-${namespace}`, entries);
    } catch (err) {
      wrapProviderError('azure', 'PutMetrics.Upload', err);
    }
  }

  async getMetrics(namespace: string, metricName: string, opts?: GetMetricsOptions): Promise<MetricDatapoint[]> {
    const client = new MetricsQueryClient(this.credential);
    const resourceUri = `/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/${namespace}`;

    const queryOpts: {
      timespan?: { startTime: Date; endTime: Date };
      aggregations?: AggregationType[];
      granularity?: string;
    } = {};
    if (opts?.startTime && opts?.endTime) {
      queryOpts.timespan = { startTime: opts.startTime, endTime: opts.endTime };
    }
    if (opts?.statistics?.length) {
      queryOpts.aggregations = [opts.statistics[0] as AggregationType];
    }
    if (opts?.period) {
      queryOpts.granularity = `PT${opts.period}S`;
    }

    try {
      const resp = await client.queryResource(resourceUri, [metricName], queryOpts);
      const result: MetricDatapoint[] = [];
      for (const metric of resp.metrics) {
        for (const ts of metric.timeseries) {
          for (const dp of ts.data ?? []) {
            result.push({ timestamp: dp.timeStamp, value: dp.average ?? 0, unit: '' });
          }
        }
      }
      return result;
    } catch (err) {
      return wrapProviderError('azure', 'GetMetrics.QueryResource', err);
    }
  }

  async createAlarm(opts: AlarmOptions): Promise<void> {
    if (!this.resourceGroup) {
      throw new UnsupportedError(
        'azure',
        'createAlarm',
        'resourceGroup is required for Azure metric alerts',
        'Provide a resourceGroup when constructing AzureMonitoring',
      );
    }

    const client = new MonitorClient(this.credential, this.subscriptionId);
    let windowSize = `PT${Math.floor(opts.period / 60) + 1}M`;
    if (windowSize === 'PT1M') windowSize = 'PT5M';
    const scope = `/subscriptions/${this.subscriptionId}`;

    try {
      await client.metricAlerts.createOrUpdate(this.resourceGroup, opts.name, {
        location: 'global',
        severity: 2,
        enabled: true,
        scopes: [scope],
        evaluationFrequency: 'PT1M',
        windowSize,
        criteria: {
          odataType: KnownOdatatype.MicrosoftAzureMonitorSingleResourceMultipleMetricCriteria,
          allOf: [
            {
              criterionType: KnownCriterionType.StaticThresholdCriterion,
              name: 'criterion1',
              metricName: opts.metricName,
              operator: KnownOperator.GreaterThan,
              threshold: opts.threshold,
              timeAggregation: KnownAggregationTypeEnum.Average,
            },
          ],
        },
      });
    } catch (err) {
      wrapProviderError('azure', 'CreateAlarm.CreateOrUpdate', err);
    }
  }

  async deleteAlarm(name: string): Promise<void> {
    if (!this.resourceGroup) {
      throw new UnsupportedError('azure', 'deleteAlarm', 'resourceGroup is required', '');
    }
    const client = new MonitorClient(this.credential, this.subscriptionId);
    try {
      await client.metricAlerts.delete(this.resourceGroup, name);
    } catch (err) {
      wrapProviderError('azure', 'DeleteAlarm', err);
    }
  }

  async listAlarms(): Promise<AlarmInfo[]> {
    const client = new MonitorClient(this.credential, this.subscriptionId);
    const result: AlarmInfo[] = [];
    try {
      for await (const r of client.metricAlerts.listBySubscription()) {
        result.push({ name: r.name ?? '', state: '', metricName: '', threshold: 0 });
      }
    } catch (err) {
      return wrapProviderError('azure', 'ListAlarms', err);
    }
    return result;
  }

  async createLogGroup(name: string): Promise<void> {
    if (!this.resourceGroup) {
      throw new UnsupportedError(
        'azure',
        'createLogGroup',
        'resourceGroup is required for Azure Log Analytics workspace creation',
        'Provide a resourceGroup when constructing AzureMonitoring',
      );
    }
    const client = new OperationalInsightsManagementClient(this.credential, this.subscriptionId);
    try {
      await client.workspaces.createOrUpdate(this.resourceGroup, name, { location: 'eastus' });
    } catch (err) {
      wrapProviderError('azure', 'CreateLogGroup.createOrUpdate', err);
    }
  }

  async deleteLogGroup(name: string): Promise<void> {
    if (!this.resourceGroup) {
      throw new UnsupportedError('azure', 'deleteLogGroup', 'resourceGroup is required', '');
    }
    const client = new OperationalInsightsManagementClient(this.credential, this.subscriptionId);
    try {
      await client.workspaces.delete(this.resourceGroup, name);
    } catch (err) {
      wrapProviderError('azure', 'DeleteLogGroup.delete', err);
    }
  }

  async putLogs(logGroup: string, logStream: string, events: LogEvent[]): Promise<void> {
    if (!this.dataCollectionEndpoint) {
      throw new UnsupportedError(
        'azure',
        'putLogs',
        'dataCollectionEndpoint is required for Azure log ingestion',
        'Provide a Data Collection Endpoint URL',
      );
    }

    const client = new LogsIngestionClient(this.dataCollectionEndpoint, this.credential);
    const entries = events.map((ev) => ({
      TimeGenerated: (ev.timestamp ?? new Date()).toISOString(),
      Message: ev.message,
      LogGroup: logGroup,
      LogStream: logStream,
    }));

    try {
      await client.upload(logGroup, `Custom-${logStream}`, entries);
    } catch (err) {
      wrapProviderError('azure', 'PutLogs.Upload', err);
    }
  }

  async getLogs(logGroup: string, logStream: string, opts?: GetLogsOptions): Promise<LogEvent[]> {
    if (!this.workspaceId) {
      throw new UnsupportedError(
        'azure',
        'getLogs',
        'workspaceID is required for Azure log queries',
        'Provide a workspaceID when constructing AzureMonitoring',
      );
    }

    const client = new LogsQueryClient(this.credential);
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 100;
    const startTime = opts?.startTime ?? new Date(Date.now() - 60 * 60 * 1000);
    const endTime = opts?.endTime ?? new Date();

    const kql = `${logStream}_CL | where TimeGenerated between(datetime(${startTime.toISOString()})..datetime(${endTime.toISOString()})) | limit ${limit}`;

    try {
      const resp = await client.queryWorkspace(this.workspaceId, kql, { startTime, endTime });
      const tables = 'tables' in resp ? resp.tables : resp.partialTables;
      const result: LogEvent[] = [];
      for (const table of tables) {
        let timeIdx = -1;
        let msgIdx = -1;
        table.columnDescriptors.forEach((col, i) => {
          if (col.name === 'TimeGenerated') timeIdx = i;
          if (col.name === 'Message') msgIdx = i;
        });
        for (const row of table.rows) {
          const rawTime = timeIdx >= 0 ? row[timeIdx] : undefined;
          const rawMsg = msgIdx >= 0 ? row[msgIdx] : undefined;
          result.push({
            timestamp: rawTime instanceof Date ? rawTime : rawTime ? new Date(String(rawTime)) : new Date(0),
            message: typeof rawMsg === 'string' ? rawMsg : '',
          });
        }
      }
      return result;
    } catch (err) {
      return wrapProviderError('azure', 'GetLogs.QueryWorkspace', err);
    }
  }
}
