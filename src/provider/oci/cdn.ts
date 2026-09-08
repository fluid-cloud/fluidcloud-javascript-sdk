import { UnsupportedError } from '../../errors.js';
import type { Cdn, CdnDistribution, CdnDistributionOptions, CdnInvalidation } from '../types/cdn.js';

const OCI_CDN_MESSAGE = 'OCI has no native CDN service';
const OCI_CDN_ALTERNATIVE = 'Use AWS CloudFront or Azure Front Door via the respective entity, or a third-party CDN';

function unsupported(op: string): UnsupportedError {
  return new UnsupportedError('oci', op, OCI_CDN_MESSAGE, OCI_CDN_ALTERNATIVE);
}

/** OCI has no native CDN service; every operation throws UnsupportedError. */
export class OciCdn implements Cdn {
  async createDistribution(_opts: CdnDistributionOptions): Promise<CdnDistribution> {
    throw unsupported('createDistribution');
  }

  async getDistribution(_id: string): Promise<CdnDistribution> {
    throw unsupported('getDistribution');
  }

  async listDistributions(): Promise<CdnDistribution[]> {
    throw unsupported('listDistributions');
  }

  async updateDistribution(_id: string, _opts: CdnDistributionOptions): Promise<CdnDistribution> {
    throw unsupported('updateDistribution');
  }

  async deleteDistribution(_id: string): Promise<void> {
    throw unsupported('deleteDistribution');
  }

  async enableDistribution(_id: string): Promise<void> {
    throw unsupported('enableDistribution');
  }

  async disableDistribution(_id: string): Promise<void> {
    throw unsupported('disableDistribution');
  }

  async createInvalidation(_id: string, _paths: string[]): Promise<string> {
    throw unsupported('createInvalidation');
  }

  async getInvalidation(_id: string, _invalidationId: string): Promise<CdnInvalidation> {
    throw unsupported('getInvalidation');
  }

  async listInvalidations(_id: string): Promise<CdnInvalidation[]> {
    throw unsupported('listInvalidations');
  }
}
