import type { Client } from '@opensearch-project/opensearch';

import { wrapProviderError } from '../../errors.js';
import type { Search, SearchDocument, SearchHit, SearchResult } from '../types/search.js';

interface RawSearchResponse {
  hits: {
    total: { value: number };
    hits: { _id: string; _score: number; _source: Record<string, unknown> }[];
  };
}

interface RawCatIndexRow {
  index?: string;
}

/** Builds the OpenSearch bulk request body as alternating meta/doc entries. */
function buildBulkBody(docs: SearchDocument[]): Record<string, unknown>[] {
  const body: Record<string, unknown>[] = [];
  for (const d of docs) {
    body.push({ index: d.id ? { _id: d.id } : {} });
    body.push(d.doc);
  }
  return body;
}

/** Shared OpenSearch REST implementation of Search, used by AWS and OCI. */
export class OpenSearchBase implements Search {
  protected constructor(
    protected readonly client: Client,
    private readonly provider: 'aws' | 'oci',
  ) {}

  async createIndex(index: string, mapping?: Record<string, unknown>): Promise<void> {
    try {
      const body = mapping && Object.keys(mapping).length > 0 ? mapping : undefined;
      await this.client.indices.create({ index, body } as never);
    } catch (err) {
      wrapProviderError(this.provider, 'createIndex', err);
    }
  }

  async deleteIndex(index: string): Promise<void> {
    try {
      await this.client.indices.delete({ index });
    } catch (err) {
      wrapProviderError(this.provider, 'deleteIndex', err);
    }
  }

  async indexExists(index: string): Promise<boolean> {
    try {
      const res = await this.client.indices.exists({ index });
      return res.body === true;
    } catch (err) {
      wrapProviderError(this.provider, 'indexExists', err);
    }
  }

  async listIndices(): Promise<string[]> {
    try {
      const res = await this.client.cat.indices({ format: 'json' });
      const rows = res.body as unknown as RawCatIndexRow[];
      return rows.map((r) => r.index ?? '');
    } catch (err) {
      wrapProviderError(this.provider, 'listIndices', err);
    }
  }

  async getMapping(index: string): Promise<Record<string, unknown>> {
    try {
      const res = await this.client.indices.getMapping({ index });
      return res.body;
    } catch (err) {
      wrapProviderError(this.provider, 'getMapping', err);
    }
  }

  async putMapping(index: string, mapping: Record<string, unknown>): Promise<void> {
    try {
      await this.client.indices.putMapping({ index, body: mapping } as never);
    } catch (err) {
      wrapProviderError(this.provider, 'putMapping', err);
    }
  }

  async refresh(index: string): Promise<void> {
    try {
      await this.client.indices.refresh({ index });
    } catch (err) {
      wrapProviderError(this.provider, 'refresh', err);
    }
  }

  async indexDocument(index: string, id: string, doc: Record<string, unknown>): Promise<void> {
    try {
      await this.client.index({ index, id, body: doc });
    } catch (err) {
      wrapProviderError(this.provider, 'indexDocument', err);
    }
  }

  async getDocument(index: string, id: string): Promise<Record<string, unknown>> {
    try {
      const res = await this.client.get({ index, id });
      return res.body._source ?? {};
    } catch (err) {
      wrapProviderError(this.provider, 'getDocument', err);
    }
  }

  async updateDocument(index: string, id: string, doc: Record<string, unknown>): Promise<void> {
    try {
      await this.client.update({ index, id, body: { doc } });
    } catch (err) {
      wrapProviderError(this.provider, 'updateDocument', err);
    }
  }

  async deleteDocument(index: string, id: string): Promise<void> {
    try {
      await this.client.delete({ index, id });
    } catch (err) {
      wrapProviderError(this.provider, 'deleteDocument', err);
    }
  }

  async bulkIndex(index: string, docs: SearchDocument[]): Promise<void> {
    if (docs.length === 0) return;
    try {
      await this.client.bulk({ index, body: buildBulkBody(docs) });
    } catch (err) {
      wrapProviderError(this.provider, 'bulkIndex', err);
    }
  }

  async search(index: string, query: Record<string, unknown>): Promise<SearchResult> {
    try {
      const body = query && Object.keys(query).length > 0 ? query : undefined;
      const res = await this.client.search({ index, body } as never);
      const raw = res.body as unknown as RawSearchResponse;
      const hits: SearchHit[] = raw.hits.hits.map((h) => ({ id: h._id, score: h._score, source: h._source }));
      return { total: raw.hits.total.value, hits };
    } catch (err) {
      wrapProviderError(this.provider, 'search', err);
    }
  }

  async count(index: string, query: Record<string, unknown>): Promise<number> {
    try {
      const body = query && Object.keys(query).length > 0 ? query : undefined;
      const res = await this.client.count({ index, body } as never);
      return res.body.count;
    } catch (err) {
      wrapProviderError(this.provider, 'count', err);
    }
  }
}
