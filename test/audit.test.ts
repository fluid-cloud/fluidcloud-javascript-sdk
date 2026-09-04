import { describe, expect, it, vi } from 'vitest';

import { UnsupportedError } from '../src/errors.js';
import type { AwsCredentials, AzureCredentials, GcpCredentials, OciCredentials } from '../src/credentials/index.js';

const awsSend = vi.hoisted(() => vi.fn());
const azureList = vi.hoisted(() => vi.fn());
const gcpGetEntries = vi.hoisted(() => vi.fn());
const ociListEvents = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-cloudtrail', () => {
  class FakeCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class FakeCloudTrailClient {
    send = awsSend;
  }
  return {
    CloudTrailClient: FakeCloudTrailClient,
    LookupEventsCommand: class extends FakeCommand {},
    CreateTrailCommand: class extends FakeCommand {},
    DeleteTrailCommand: class extends FakeCommand {},
    DescribeTrailsCommand: class extends FakeCommand {},
    GetTrailStatusCommand: class extends FakeCommand {},
  };
});

vi.mock('@azure/arm-monitor', () => {
  class FakeMonitorClient {
    activityLogs = { list: azureList };
  }
  return { MonitorClient: FakeMonitorClient };
});

vi.mock('@google-cloud/logging', () => {
  class FakeLogging {
    getEntries = gcpGetEntries;
  }
  return { Logging: FakeLogging };
});

vi.mock('oci-audit', () => {
  class FakeAuditClient {
    listEvents = ociListEvents;
    regionId: string | undefined = undefined;
  }
  return { AuditClient: FakeAuditClient };
});

const { CloudTrailAudit } = await import('../src/provider/aws/audit.js');
const { ActivityLogAudit } = await import('../src/provider/azure/audit.js');
const { CloudAudit } = await import('../src/provider/gcp/audit.js');
const { OciAudit } = await import('../src/provider/oci/audit.js');

const awsCreds: AwsCredentials = { accessKey: 'AKIA', secretAccessKey: 'shh', region: 'us-east-1' };
const azureCreds: AzureCredentials = { tenantId: 't', clientId: 'c', clientSecret: 's', subscriptionId: 'sub-1' };
const gcpCreds: GcpCredentials = { projectId: 'proj-1', serviceAccountJson: '{}' };
const ociCreds: OciCredentials = {
  tenancyOcid: 'ocid1.tenancy.1',
  userOcid: 'ocid1.user.1',
  fingerprint: 'fp',
  privateKey: 'pk',
  region: 'us-ashburn-1',
  compartmentOcid: 'ocid1.compartment.1',
};

describe('CloudTrailAudit (aws)', () => {
  it('looks up events, paginates and maps fields', async () => {
    awsSend
      .mockResolvedValueOnce({
        Events: [
          {
            EventId: 'e1',
            EventName: 'CreateBucket',
            EventTime: new Date('2026-01-01T00:00:00Z'),
            Username: 'alice',
            Resources: [{ ResourceName: 'my-bucket', ResourceType: 'AWS::S3::Bucket' }],
          },
        ],
        NextToken: 'tok-2',
      })
      .mockResolvedValueOnce({ Events: [{ EventId: 'e2', EventName: 'DeleteBucket' }] });

    const audit = new CloudTrailAudit(awsCreds);
    const start = new Date('2026-01-01T00:00:00Z');
    const events = await audit.lookupEvents({ startTime: start, maxResults: 10 });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: 'e1',
      name: 'CreateBucket',
      username: 'alice',
      resourceId: 'my-bucket',
      resourceType: 'AWS::S3::Bucket',
      region: 'us-east-1',
    });
    expect(events[0].raw).toBeDefined();
    expect(events[1]).toMatchObject({ id: 'e2', resourceId: '', resourceType: '' });

    expect(awsSend).toHaveBeenCalledTimes(2);
    const firstInput = (awsSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(firstInput).toMatchObject({ StartTime: start, MaxResults: 10 });
    const secondInput = (awsSend.mock.calls[1][0] as { input: Record<string, unknown> }).input;
    expect(secondInput.NextToken).toBe('tok-2');
  });

  it('creates, deletes, lists and reads trail status', async () => {
    awsSend.mockReset();
    awsSend.mockResolvedValueOnce({});
    const audit = new CloudTrailAudit(awsCreds);
    await audit.createTrail('my-trail', { s3BucketName: 'bucket', isMultiRegion: true });
    const createInput = (awsSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(createInput).toMatchObject({ Name: 'my-trail', S3BucketName: 'bucket', IsMultiRegionTrail: true });

    awsSend.mockResolvedValueOnce({});
    await audit.deleteTrail('my-trail');
    const deleteInput = (awsSend.mock.calls[1][0] as { input: Record<string, unknown> }).input;
    expect(deleteInput).toMatchObject({ Name: 'my-trail' });

    awsSend.mockResolvedValueOnce({ trailList: [{ Name: 'my-trail', S3BucketName: 'bucket', IsMultiRegionTrail: true }] });
    const trails = await audit.listTrails();
    expect(trails).toEqual([{ name: 'my-trail', s3BucketName: 'bucket', isMultiRegion: true }]);

    awsSend.mockResolvedValueOnce({ IsLogging: true, LatestDeliveryTime: new Date('2026-01-01T00:00:00Z') });
    const status = await audit.getTrailStatus('my-trail');
    expect(status).toEqual({ isLogging: true, latestDeliveryTime: new Date('2026-01-01T00:00:00Z') });
  });

  it('wraps a provider error', async () => {
    awsSend.mockReset();
    awsSend.mockRejectedValueOnce(new Error('boom'));
    const audit = new CloudTrailAudit(awsCreds);
    await expect(audit.lookupEvents()).rejects.toThrow('aws: lookupEvents failed: boom');
  });
});

describe('ActivityLogAudit (azure)', () => {
  it('builds an OData filter from the time window and maps events', async () => {
    azureList.mockReturnValueOnce(
      (async function* () {
        yield {
          eventDataId: 'ev-1',
          operationName: { value: 'Microsoft.Compute/virtualMachines/write' },
          eventTimestamp: new Date('2026-01-01T00:00:00Z'),
          caller: 'bob@example.com',
          resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/x',
        };
      })(),
    );

    const audit = new ActivityLogAudit(azureCreds);
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-02T00:00:00Z');
    const events = await audit.lookupEvents({ startTime: start, endTime: end });

    expect(events).toEqual([
      {
        id: 'ev-1',
        name: 'Microsoft.Compute/virtualMachines/write',
        time: new Date('2026-01-01T00:00:00Z'),
        username: 'bob@example.com',
        resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/x',
        resourceType: '',
        region: '',
        raw: events[0].raw,
      },
    ]);
    expect(azureList).toHaveBeenCalledWith("eventTimestamp ge '2026-01-01T00:00:00Z' and eventTimestamp le '2026-01-02T00:00:00Z'");
  });

  it('defaults the filter to an open time window when none is given', async () => {
    azureList.mockReturnValueOnce((async function* () {})());
    const audit = new ActivityLogAudit(azureCreds);
    await audit.lookupEvents();
    expect(azureList).toHaveBeenCalledWith("eventTimestamp ge '1970-01-01T00:00:00Z'");
  });

  it('has no trail lifecycle', async () => {
    const audit = new ActivityLogAudit(azureCreds);
    await expect(audit.createTrail('t', { s3BucketName: 'x' })).rejects.toThrow(UnsupportedError);
    await expect(audit.deleteTrail('t')).rejects.toThrow(UnsupportedError);
    await expect(audit.getTrailStatus('t')).rejects.toThrow(UnsupportedError);
    await expect(audit.listTrails()).resolves.toEqual([]);
  });
});

describe('CloudAudit (gcp)', () => {
  it('builds a Cloud Logging filter and maps entries', async () => {
    gcpGetEntries.mockResolvedValueOnce([
      [
        {
          metadata: {
            insertId: 'ins-1',
            logName: 'projects/proj-1/logs/cloudaudit.googleapis.com%2Factivity',
            timestamp: new Date('2026-01-01T00:00:00Z'),
            resource: { type: 'gce_instance', labels: { location: 'us-central1-a' } },
          },
        },
      ],
    ]);

    const audit = new CloudAudit(gcpCreds);
    const start = new Date('2026-01-01T00:00:00Z');
    const events = await audit.lookupEvents({ startTime: start, resourceType: 'gce_instance', maxResults: 5 });

    expect(events).toEqual([
      {
        id: 'ins-1',
        name: 'projects/proj-1/logs/cloudaudit.googleapis.com%2Factivity',
        time: new Date('2026-01-01T00:00:00Z'),
        username: '',
        resourceId: '',
        resourceType: 'gce_instance',
        region: 'us-central1-a',
        raw: events[0].raw,
      },
    ]);

    const call = gcpGetEntries.mock.calls[0][0] as { filter: string; maxResults: number };
    expect(call.filter).toContain('logName:"cloudaudit.googleapis.com"');
    expect(call.filter).toContain(`timestamp>="${start.toISOString()}"`);
    expect(call.filter).toContain('resource.type="gce_instance"');
    expect(call.maxResults).toBe(5);
  });

  it('has no trail lifecycle', async () => {
    const audit = new CloudAudit(gcpCreds);
    await expect(audit.createTrail('t', { s3BucketName: 'x' })).rejects.toThrow(UnsupportedError);
    await expect(audit.deleteTrail('t')).rejects.toThrow(UnsupportedError);
    await expect(audit.listTrails()).rejects.toThrow(UnsupportedError);
    await expect(audit.getTrailStatus('t')).rejects.toThrow(UnsupportedError);
  });
});

describe('OciAudit (oci)', () => {
  it('defaults to the last 24 hours and paginates', async () => {
    ociListEvents
      .mockResolvedValueOnce({
        items: [
          {
            eventId: 'evt-1',
            eventTime: new Date('2026-01-01T00:00:00Z'),
            data: { eventName: 'GetInstance', resourceId: 'ocid1.instance.1', identity: { principalName: 'carol' } },
          },
        ],
        opcNextPage: 'page-2',
      })
      .mockResolvedValueOnce({ items: [{ eventId: 'evt-2' }], opcNextPage: undefined });

    const audit = new OciAudit(ociCreds, 'ocid1.compartment.1');
    const events = await audit.lookupEvents();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: 'evt-1', name: 'GetInstance', resourceId: 'ocid1.instance.1', username: 'carol' });
    expect(ociListEvents).toHaveBeenCalledTimes(2);

    const firstRequest = ociListEvents.mock.calls[0][0] as { compartmentId: string; startTime: Date; endTime: Date };
    expect(firstRequest.compartmentId).toBe('ocid1.compartment.1');
    expect(firstRequest.endTime.getTime() - firstRequest.startTime.getTime()).toBeCloseTo(24 * 60 * 60 * 1000, -3);
  });

  it('falls back to the credential compartment when none is passed', async () => {
    ociListEvents.mockResolvedValueOnce({ items: [], opcNextPage: undefined });
    const audit = new OciAudit(ociCreds, '');
    await audit.lookupEvents();
    const request = ociListEvents.mock.calls[0][0] as { compartmentId: string };
    expect(request.compartmentId).toBe('ocid1.compartment.1');
  });

  it('has no trail lifecycle', async () => {
    const audit = new OciAudit(ociCreds, 'ocid1.compartment.1');
    await expect(audit.createTrail('t', { s3BucketName: 'x' })).rejects.toThrow(UnsupportedError);
    await expect(audit.deleteTrail('t')).rejects.toThrow(UnsupportedError);
    await expect(audit.getTrailStatus('t')).rejects.toThrow(UnsupportedError);
    await expect(audit.listTrails()).resolves.toEqual([]);
  });
});
