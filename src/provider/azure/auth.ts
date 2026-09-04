import { ClientSecretCredential } from '@azure/identity';

import type { AzureCredentials } from '../../credentials/index.js';

/** Builds the service-principal token credential used by every Azure client. */
export function azureCredential(creds: AzureCredentials): ClientSecretCredential {
  return new ClientSecretCredential(creds.tenantId, creds.clientId, creds.clientSecret);
}

/** Builds an Azure Resource Manager resource ID prefix for the subscription. */
export function subscriptionScope(creds: AzureCredentials): string {
  return `/subscriptions/${creds.subscriptionId}`;
}

/** Builds a resource-group scope, or the subscription scope when none is given. */
export function resourceGroupScope(creds: AzureCredentials, resourceGroup: string): string {
  return resourceGroup
    ? `/subscriptions/${creds.subscriptionId}/resourceGroups/${resourceGroup}`
    : subscriptionScope(creds);
}
