import { describe, it, expect, vi, beforeEach } from 'vitest';

import { UnsupportedError, NotFoundError } from '../src/errors.js';
import type { AwsCredentials, AzureCredentials, GcpCredentials, OciCredentials } from '../src/credentials/index.js';

const cwSend = vi.fn();
const cwLogsSend = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudwatch')>('@aws-sdk/client-cloudwatch');
  return { ...actual, CloudWatchClient: vi.fn().mockImplementation(function () { return { send: cwSend }; }) };
});

vi.mock('@aws-sdk/client-cloudwatch-logs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudwatch-logs')>('@aws-sdk/client-cloudwatch-logs');
  return { ...actual, CloudWatchLogsClient: vi.fn().mockImplementation(function () { return { send: cwLogsSend }; }) };
});

const gcpWrite = vi.fn().mockResolvedValue([{}]);
const gcpDelete = vi.fn().mockResolvedValue([{}]);
const gcpGetEntries = vi.fn();

vi.mock('@google-cloud/logging', () => ({
  Logging: vi.fn().mockImplementation(function () {
    return {
      log: vi.fn().mockImplementation(function () {
        return {
          write: gcpWrite,
          delete: gcpDelete,
          entry: (metadata: unknown, data: unknown) => ({ metadata, data }),
        };
      }),
      getEntries: gcpGetEntries,
    };
  }),
}));

const ociPostMetricData = vi.fn().mockResolvedValue({});
const ociSummarize = vi.fn();
const ociCreateAlarm = vi.fn().mockResolvedValue({});
const ociDeleteAlarm = vi.fn().mockResolvedValue({});
const ociListAlarms = vi.fn();
const ociSearchLogs = vi.fn();

vi.mock('oci-monitoring', async () => {
  const actual = await vi.importActual<typeof import('oci-monitoring')>('oci-monitoring');
  return {
    ...actual,
    MonitoringClient: vi.fn().mockImplementation(function () {
      return {
        postMetricData: ociPostMetricData,
        summarizeMetricsData: ociSummarize,
        createAlarm: ociCreateAlarm,
        deleteAlarm: ociDeleteAlarm,
        listAlarms: ociListAlarms,
      };
    }),
  };
});

vi.mock('oci-loggingsearch', async () => {
  const actual = await vi.importActual<typeof import('oci-loggingsearch')>('oci-loggingsearch');
  return {
    ...actual,
    LogSearchClient: vi.fn().mockImplementation(function () {
      return { searchLogs: ociSearchLogs };
    }),
  };
});

const ociCreateLogGroup = vi.fn().mockResolvedValue({});
const ociListLogGroups = vi.fn();
const ociDeleteLogGroup = vi.fn().mockResolvedValue({});
const ociListLogs = vi.fn();
const ociPutLogs = vi.fn().mockResolvedValue({});

vi.mock('oci-logging', async () => {
  const actual = await vi.importActual<typeof import('oci-logging')>('oci-logging');
  return {
    ...actual,
    LoggingManagementClient: vi.fn().mockImplementation(function () {
      return {
        createLogGroup: ociCreateLogGroup,
        listLogGroups: ociListLogGroups,
        listLogs: ociListLogs,
        deleteLogGroup: ociDeleteLogGroup,
      };
    }),
  };
});

vi.mock('oci-loggingingestion', async () => {
  const actual = await vi.importActual<typeof import('oci-loggingingestion')>('oci-loggingingestion');
  return {
    ...actual,
    LoggingClient: vi.fn().mockImplementation(function () {
      return { putLogs: ociPutLogs };
    }),
  };
});

const { CloudWatchMonitoring } = await import('../src/provider/aws/monitoring.js');
const { AzureMonitoring } = await import('../src/provider/azure/monitoring.js');
const { CloudMonitoring } = await import('../src/provider/gcp/monitoring.js');
const { OciMonitoring } = await import('../src/provider/oci/monitoring.js');

const awsCreds: AwsCredentials = { accessKey: 'AK', secretAccessKey: 'SK', region: 'us-east-1' };
const azureCreds: AzureCredentials = {
  tenantId: 't',
  clientId: 'c',
  clientSecret: 's',
  subscriptionId: 'sub',
};
const gcpCreds: GcpCredentials = { projectId: 'proj', serviceAccountJson: '{}' };
const ociCreds: OciCredentials = {
  tenancyOcid: 'ocid1.tenancy.oc1..a',
  userOcid: 'ocid1.user.oc1..a',
  fingerprint: 'ff',
  privateKey: '-----BEGIN PRIVATE KEY-----\nzz\n-----END PRIVATE KEY-----',
  region: 'us-ashburn-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('aws CloudWatchMonitoring', () => {
  it('putMetrics maps dimensions and unit onto PutMetricData', async () => {
    cwSend.mockResolvedValue({});
    const m = new CloudWatchMonitoring(awsCreds);
    await m.putMetrics('NS', [{ name: 'cpu', value: 42, unit: 'Percent', dimensions: { host: 'h1' } }]);
    const input = cwSend.mock.calls[0][0].input;
    expect(input.Namespace).toBe('NS');
    expect(input.MetricData[0]).toMatchObject({ MetricName: 'cpu', Value: 42, Unit: 'Percent' });
    expect(input.MetricData[0].Dimensions).toEqual([{ Name: 'host', Value: 'h1' }]);
  });

  it('createAlarm copies comparisonOperator and statistic verbatim', async () => {
    cwSend.mockResolvedValue({});
    const m = new CloudWatchMonitoring(awsCreds);
    await m.createAlarm({
      name: 'high-cpu',
      metricName: 'CPUUtilization',
      namespace: 'AWS/EC2',
      threshold: 80,
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 3,
      period: 60,
      statistic: 'Average',
    });
    const input = cwSend.mock.calls[0][0].input;
    expect(input.ComparisonOperator).toBe('GreaterThanThreshold');
    expect(input.Statistic).toBe('Average');
    expect(input.EvaluationPeriods).toBe(3);
  });

  it('putLogs tolerates an already-existing log stream', async () => {
    const { ResourceAlreadyExistsException } = await import('@aws-sdk/client-cloudwatch-logs');
    cwLogsSend
      .mockRejectedValueOnce(
        new ResourceAlreadyExistsException({ message: 'exists', $metadata: {} }),
      )
      .mockResolvedValueOnce({});
    const m = new CloudWatchMonitoring(awsCreds);
    await expect(
      m.putLogs('lg', 'ls', [{ timestamp: new Date('2024-01-01T00:00:00Z'), message: 'hi' }]),
    ).resolves.toBeUndefined();
    expect(cwLogsSend).toHaveBeenCalledTimes(2);
  });
});

describe('gcp CloudMonitoring — metrics and alarms are unsupported', () => {
  const cases: Array<[string, (m: InstanceType<typeof CloudMonitoring>) => Promise<unknown>]> = [
    ['putMetrics', (m) => m.putMetrics('ns', [])],
    ['getMetrics', (m) => m.getMetrics('ns', 'm')],
    ['createAlarm', (m) => m.createAlarm({ name: 'a', metricName: 'm', namespace: 'ns', threshold: 1, comparisonOperator: '>', evaluationPeriods: 1, period: 60, statistic: 'Average' })],
    ['deleteAlarm', (m) => m.deleteAlarm('a')],
    ['listAlarms', (m) => m.listAlarms()],
  ];

  it.each(cases)('%s throws UnsupportedError', async (_name, call) => {
    const m = new CloudMonitoring(gcpCreds);
    await expect(call(m)).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('createLogGroup is a no-op', async () => {
    const m = new CloudMonitoring(gcpCreds);
    await expect(m.createLogGroup('lg')).resolves.toBeUndefined();
  });

  it('putLogs writes entries and deleteLogGroup deletes the log', async () => {
    const m = new CloudMonitoring(gcpCreds);
    await m.putLogs('lg', 'ignored', [{ timestamp: new Date('2024-01-01T00:00:00Z'), message: 'hi' }]);
    expect(gcpWrite).toHaveBeenCalledWith([{ metadata: { timestamp: new Date('2024-01-01T00:00:00Z') }, data: 'hi' }]);
    await m.deleteLogGroup('lg');
    expect(gcpDelete).toHaveBeenCalled();
  });

  it('getLogs maps entries and filters by log name', async () => {
    gcpGetEntries.mockResolvedValue([[{ metadata: { timestamp: new Date('2024-01-01T00:00:00Z') }, data: 'hello' }]]);
    const m = new CloudMonitoring(gcpCreds);
    const events = await m.getLogs('lg', 'ignored');
    expect(events).toEqual([{ timestamp: new Date('2024-01-01T00:00:00Z'), message: 'hello' }]);
    expect(gcpGetEntries.mock.calls[0][0].filter).toContain('logName="projects/proj/logs/lg"');
  });
});

describe('oci OciMonitoring', () => {
  it('createAlarm maps statistic to alarm severity', async () => {
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await m.createAlarm({
      name: 'high-cpu',
      metricName: 'CpuUtilization',
      namespace: 'oci_computeagent',
      threshold: 80,
      comparisonOperator: '>',
      evaluationPeriods: 1,
      period: 60,
      statistic: 'CRITICAL',
    });
    const details = ociCreateAlarm.mock.calls[0][0].createAlarmDetails;
    expect(details.severity).toBe('CRITICAL');
    expect(details.compartmentId).toBe('compartment-1');
  });

  it('deleteAlarm throws NotFoundError when no alarm matches', async () => {
    ociListAlarms.mockResolvedValue({ items: [{ displayName: 'other', id: 'ocid1.alarm.1' }] });
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await expect(m.deleteAlarm('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteAlarm deletes the matching alarm by display name', async () => {
    ociListAlarms.mockResolvedValue({ items: [{ displayName: 'target', id: 'ocid1.alarm.1' }] });
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await m.deleteAlarm('target');
    expect(ociDeleteAlarm).toHaveBeenCalledWith({ alarmId: 'ocid1.alarm.1' });
  });

  it('createLogGroup creates a log group in the compartment', async () => {
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await m.createLogGroup('my-logs');
    expect(ociCreateLogGroup).toHaveBeenCalledWith({
      createLogGroupDetails: { compartmentId: 'compartment-1', displayName: 'my-logs' },
    });
  });

  it('deleteLogGroup looks up the group by display name and deletes it', async () => {
    ociListLogGroups.mockResolvedValue({ items: [{ displayName: 'my-logs', id: 'ocid1.loggroup.1' }] });
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await m.deleteLogGroup('my-logs');
    expect(ociDeleteLogGroup).toHaveBeenCalledWith({ logGroupId: 'ocid1.loggroup.1' });
  });

  it('deleteLogGroup throws NotFoundError when no group matches', async () => {
    ociListLogGroups.mockResolvedValue({ items: [{ displayName: 'other', id: 'ocid1.loggroup.2' }] });
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await expect(m.deleteLogGroup('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('putLogs resolves the group and stream to a real Log OCID before ingesting', async () => {
    ociListLogGroups.mockResolvedValue({ items: [{ displayName: 'my-logs', id: 'ocid1.loggroup.1' }] });
    ociListLogs.mockResolvedValue({ items: [{ displayName: 'instance-1', id: 'ocid1.log.99' }] });

    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await m.putLogs('my-logs', 'instance-1', [
      { timestamp: new Date('2024-01-01T00:00:00Z'), message: 'hi' },
      { timestamp: new Date('2024-01-01T00:00:01Z'), message: 'bye' },
    ]);

    expect(ociListLogs).toHaveBeenCalledWith(expect.objectContaining({ logGroupId: 'ocid1.loggroup.1' }));

    const req = ociPutLogs.mock.calls[0][0];
    // The Log OCID, not the group name, is what ingestion addresses.
    expect(req.logId).toBe('ocid1.log.99');
    expect(req.putLogsDetails.logEntryBatches[0]).toMatchObject({ source: 'instance-1', type: 'my-logs' });
    expect(req.putLogsDetails.logEntryBatches[0].entries).toEqual([
      { id: 'my-logs-instance-1-0', data: 'hi', time: new Date('2024-01-01T00:00:00Z') },
      { id: 'my-logs-instance-1-1', data: 'bye', time: new Date('2024-01-01T00:00:01Z') },
    ]);
  });

  it.each([
    ['the log group does not exist', { items: [{ displayName: 'other', id: 'ocid1.loggroup.2' }] }, { items: [] }],
    ['the log does not exist in the group', { items: [{ displayName: 'my-logs', id: 'ocid1.loggroup.1' }] }, { items: [{ displayName: 'other', id: 'ocid1.log.2' }] }],
  ])('putLogs fails clearly when %s', async (_name, groups, logs) => {
    ociListLogGroups.mockResolvedValue(groups);
    ociListLogs.mockResolvedValue(logs);
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await expect(m.putLogs('my-logs', 'instance-1', [])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getLogs surfaces a search failure instead of returning an empty array', async () => {
    ociSearchLogs.mockRejectedValue(new Error('boom'));
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await expect(m.getLogs('lg', 'ls')).rejects.toThrow(/boom/);
  });

  it.each([
    ['rfc3339 datetime', { datetime: '2026-09-04T10:30:00Z' }, new Date('2026-09-04T10:30:00Z')],
    ['time key', { time: '2026-09-04T10:30:00Z' }, new Date('2026-09-04T10:30:00Z')],
    ['epoch millis', { datetime: Date.parse('2026-09-04T10:30:00Z') }, new Date('2026-09-04T10:30:00Z')],
    ['no timestamp field', { msg: 'hi' }, new Date(0)],
  ])('getLogs reads the entry timestamp from %s rather than stamping now', async (_name, data, want) => {
    ociSearchLogs.mockResolvedValue({ searchResponse: { results: [{ data }] } });
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    const [event] = await m.getLogs('lg', 'ls');
    expect(event.timestamp).toEqual(want);
  });

  it('getLogs honors the limit option in the search query', async () => {
    ociSearchLogs.mockResolvedValue({ searchResponse: { results: [] } });
    const m = new OciMonitoring(ociCreds, 'compartment-1');
    await m.getLogs('lg', 'ls', { limit: 7 });
    expect(ociSearchLogs.mock.calls.at(-1)![0].searchLogsDetails.searchQuery).toContain('limit 7');
  });
});

describe('azure AzureMonitoring — required configuration is enforced', () => {
  const missingResourceGroup = new AzureMonitoring(azureCreds, '', 'workspace-1', 'https://dce.example.com');
  const missingDce = new AzureMonitoring(azureCreds, 'rg', 'workspace-1', '');
  const missingWorkspace = new AzureMonitoring(azureCreds, 'rg', '', 'https://dce.example.com');

  const cases: Array<[string, () => Promise<unknown>]> = [
    ['createAlarm without resourceGroup', () => missingResourceGroup.createAlarm({ name: 'a', metricName: 'm', namespace: 'ns', threshold: 1, comparisonOperator: 'GreaterThan', evaluationPeriods: 1, period: 60, statistic: 'Average' })],
    ['deleteAlarm without resourceGroup', () => missingResourceGroup.deleteAlarm('a')],
    ['createLogGroup without resourceGroup', () => missingResourceGroup.createLogGroup('lg')],
    ['deleteLogGroup without resourceGroup', () => missingResourceGroup.deleteLogGroup('lg')],
    ['putMetrics without dataCollectionEndpoint', () => missingDce.putMetrics('ns', [])],
    ['putLogs without dataCollectionEndpoint', () => missingDce.putLogs('lg', 'ls', [])],
    ['getLogs without workspaceId', () => missingWorkspace.getLogs('lg', 'ls')],
  ];

  it.each(cases)('%s throws UnsupportedError', async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(UnsupportedError);
  });
});
