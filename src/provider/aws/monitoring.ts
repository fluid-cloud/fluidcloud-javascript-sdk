import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  GetMetricStatisticsCommand,
  PutMetricAlarmCommand,
  PutMetricDataCommand,
  type ComparisonOperator,
  type Statistic,
  type StandardUnit,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DeleteLogGroupCommand,
  GetLogEventsCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-cloudwatch-logs';

import { wrapProviderError } from '../../errors.js';
import type { AwsCredentials } from '../../credentials/index.js';
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
import { awsClientConfig } from './auth.js';

/** AWS CloudWatch and CloudWatch Logs backed monitoring. */
export class CloudWatchMonitoring implements Monitoring {
  private readonly metricsClient: CloudWatchClient;
  private readonly logsClient: CloudWatchLogsClient;

  constructor(creds: AwsCredentials) {
    const cfg = awsClientConfig(creds);
    this.metricsClient = new CloudWatchClient(cfg);
    this.logsClient = new CloudWatchLogsClient(cfg);
  }

  async putMetrics(namespace: string, metrics: MetricDatum[]): Promise<void> {
    const metricData = metrics.map((metric) => ({
      MetricName: metric.name,
      Value: metric.value,
      Timestamp: metric.timestamp,
      Unit: (metric.unit || 'None') as StandardUnit,
      Dimensions: metric.dimensions
        ? Object.entries(metric.dimensions).map(([Name, Value]) => ({ Name, Value }))
        : undefined,
    }));
    try {
      await this.metricsClient.send(new PutMetricDataCommand({ Namespace: namespace, MetricData: metricData }));
    } catch (err) {
      wrapProviderError('aws', 'PutMetricData', err);
    }
  }

  async getMetrics(namespace: string, metricName: string, opts?: GetMetricsOptions): Promise<MetricDatapoint[]> {
    try {
      const out = await this.metricsClient.send(
        new GetMetricStatisticsCommand({
          Namespace: namespace,
          MetricName: metricName,
          Period: opts?.period ?? 60,
          StartTime: opts?.startTime ?? new Date(Date.now() - 60 * 60 * 1000),
          EndTime: opts?.endTime ?? new Date(),
          Statistics: (opts?.statistics?.length ? opts.statistics : ['Average']) as Statistic[],
        }),
      );
      return (out.Datapoints ?? []).map((dp) => ({
        timestamp: dp.Timestamp ?? new Date(0),
        value: dp.Average ?? 0,
        unit: dp.Unit ?? '',
      }));
    } catch (err) {
      return wrapProviderError('aws', 'GetMetricStatistics', err);
    }
  }

  async createAlarm(opts: AlarmOptions): Promise<void> {
    try {
      await this.metricsClient.send(
        new PutMetricAlarmCommand({
          AlarmName: opts.name,
          MetricName: opts.metricName,
          Namespace: opts.namespace,
          Threshold: opts.threshold,
          ComparisonOperator: opts.comparisonOperator as ComparisonOperator,
          EvaluationPeriods: opts.evaluationPeriods,
          Period: opts.period,
          Statistic: opts.statistic as Statistic,
          AlarmActions: opts.alarmActions?.length ? opts.alarmActions : undefined,
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'PutMetricAlarm', err);
    }
  }

  async deleteAlarm(name: string): Promise<void> {
    try {
      await this.metricsClient.send(new DeleteAlarmsCommand({ AlarmNames: [name] }));
    } catch (err) {
      wrapProviderError('aws', 'DeleteAlarms', err);
    }
  }

  async listAlarms(): Promise<AlarmInfo[]> {
    const alarms: AlarmInfo[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.metricsClient.send(new DescribeAlarmsCommand({ NextToken: nextToken }));
        for (const a of out.MetricAlarms ?? []) {
          alarms.push({
            name: a.AlarmName ?? '',
            state: a.StateValue ?? '',
            metricName: a.MetricName ?? '',
            threshold: a.Threshold ?? 0,
          });
        }
        nextToken = out.NextToken;
      } while (nextToken);
    } catch (err) {
      return wrapProviderError('aws', 'DescribeAlarms', err);
    }
    return alarms;
  }

  async createLogGroup(name: string): Promise<void> {
    try {
      await this.logsClient.send(new CreateLogGroupCommand({ logGroupName: name }));
    } catch (err) {
      wrapProviderError('aws', 'CreateLogGroup', err);
    }
  }

  async deleteLogGroup(name: string): Promise<void> {
    try {
      await this.logsClient.send(new DeleteLogGroupCommand({ logGroupName: name }));
    } catch (err) {
      wrapProviderError('aws', 'DeleteLogGroup', err);
    }
  }

  async putLogs(logGroup: string, logStream: string, events: LogEvent[]): Promise<void> {
    try {
      await this.logsClient.send(new CreateLogStreamCommand({ logGroupName: logGroup, logStreamName: logStream }));
    } catch (err) {
      if (!(err instanceof ResourceAlreadyExistsException)) {
        wrapProviderError('aws', 'CreateLogStream', err);
      }
    }

    const logEvents = events.map((event) => ({
      timestamp: event.timestamp.getTime(),
      message: event.message,
    }));

    try {
      await this.logsClient.send(
        new PutLogEventsCommand({ logGroupName: logGroup, logStreamName: logStream, logEvents }),
      );
    } catch (err) {
      wrapProviderError('aws', 'PutLogEvents', err);
    }
  }

  async getLogs(logGroup: string, logStream: string, opts?: GetLogsOptions): Promise<LogEvent[]> {
    try {
      const out = await this.logsClient.send(
        new GetLogEventsCommand({
          logGroupName: logGroup,
          logStreamName: logStream,
          startTime: opts?.startTime?.getTime(),
          endTime: opts?.endTime?.getTime(),
          limit: opts?.limit,
        }),
      );
      return (out.events ?? []).map((e) => ({
        timestamp: e.timestamp !== undefined ? new Date(e.timestamp) : new Date(0),
        message: e.message ?? '',
      }));
    } catch (err) {
      return wrapProviderError('aws', 'GetLogEvents', err);
    }
  }
}
