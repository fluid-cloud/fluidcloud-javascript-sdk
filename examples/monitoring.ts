import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  {
    resourceGroup: process.env.AZURE_RESOURCE_GROUP,
    logAnalyticsWorkspaceId: process.env.AZURE_WORKSPACE_ID,
    dataCollectionEndpoint: process.env.AZURE_DCE_URL,
    compartment: process.env.OCI_COMPARTMENT_OCID,
  },
);

const monitoring = client.monitoring;

await monitoring.putMetrics('MyApp', [
  { name: 'RequestCount', value: 42, unit: 'Count', dimensions: { service: 'api' }, timestamp: new Date() },
]);

const datapoints = await monitoring.getMetrics('MyApp', 'RequestCount', {
  startTime: new Date(Date.now() - 60 * 60 * 1000),
  endTime: new Date(),
  period: 300,
  statistics: ['Average'],
});
console.log('datapoints:', datapoints);

await monitoring.createAlarm({
  name: 'high-request-count',
  metricName: 'RequestCount',
  namespace: 'MyApp',
  threshold: 1000,
  comparisonOperator: 'GreaterThanThreshold',
  evaluationPeriods: 3,
  period: 300,
  statistic: 'Average',
});

const alarms = await monitoring.listAlarms();
console.log('alarms:', alarms);

await monitoring.createLogGroup('my-app-logs');
await monitoring.putLogs('my-app-logs', 'instance-1', [{ timestamp: new Date(), message: 'service started' }]);
const events = await monitoring.getLogs('my-app-logs', 'instance-1', { limit: 50 });
console.log('log events:', events);

await monitoring.deleteAlarm('high-request-count');
await monitoring.deleteLogGroup('my-app-logs');

await client.close();
