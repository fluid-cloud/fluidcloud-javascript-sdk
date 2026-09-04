export interface MetricDatum {
  name: string;
  value: number;
  unit?: string;
  dimensions?: Record<string, string>;
  timestamp?: Date;
}

export interface MetricDatapoint {
  timestamp: Date;
  value: number;
  unit: string;
}

export interface GetMetricsOptions {
  startTime?: Date;
  endTime?: Date;
  /** Aggregation period in seconds. */
  period?: number;
  statistics?: string[];
}

export interface AlarmOptions {
  name: string;
  metricName: string;
  namespace: string;
  threshold: number;
  comparisonOperator: string;
  evaluationPeriods: number;
  /** Evaluation period in seconds. */
  period: number;
  statistic: string;
  alarmActions?: string[];
}

export interface AlarmInfo {
  name: string;
  state: string;
  metricName: string;
  threshold: number;
}

export interface LogEvent {
  timestamp: Date;
  message: string;
}

export interface GetLogsOptions {
  startTime?: Date;
  endTime?: Date;
  limit?: number;
}

/** Unified metrics, alarms and logs. */
export interface Monitoring {
  /** Publishes custom metrics into a namespace. */
  putMetrics(namespace: string, metrics: MetricDatum[]): Promise<void>;

  /** Reads datapoints for a metric. */
  getMetrics(namespace: string, metricName: string, opts?: GetMetricsOptions): Promise<MetricDatapoint[]>;

  /** Creates a metric alarm. */
  createAlarm(opts: AlarmOptions): Promise<void>;

  /** Deletes a metric alarm. */
  deleteAlarm(name: string): Promise<void>;

  /** Lists metric alarms. */
  listAlarms(): Promise<AlarmInfo[]>;

  /** Creates a log group. */
  createLogGroup(name: string): Promise<void>;

  /** Deletes a log group. */
  deleteLogGroup(name: string): Promise<void>;

  /** Writes log events to a stream. */
  putLogs(logGroup: string, logStream: string, events: LogEvent[]): Promise<void>;

  /** Reads log events from a stream. */
  getLogs(logGroup: string, logStream: string, opts?: GetLogsOptions): Promise<LogEvent[]>;
}
