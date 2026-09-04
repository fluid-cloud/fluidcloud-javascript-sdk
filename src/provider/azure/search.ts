import { AzureKeyCredential, SearchClient, SearchIndexClient, type SearchIndex } from '@azure/search-documents';

import { InvalidCredentialsError, UnsupportedError, wrapProviderError } from '../../errors.js';
import type { Search, SearchDocument, SearchHit, SearchResult } from '../types/search.js';

type AzureDoc = Record<string, unknown>;

const mappingUnsupportedMessage = 'Azure AI Search has no Elasticsearch-style mapping/refresh API';
const mappingUnsupportedAlternative = 'Define fields via CreateIndex; indexing is near-real-time';

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 404;
}

function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Azure AI Search-backed Search. Index, document and search operations map onto the
 * Azure REST API; Elasticsearch-style mapping introspection and Refresh have no
 * Azure equivalent and throw UnsupportedError.
 */
export class AiSearch implements Search {
  private readonly indexClient: SearchIndexClient;
  private readonly credential: AzureKeyCredential;

  constructor(endpoint: string, apiKey: string) {
    if (!endpoint) throw new InvalidCredentialsError('endpoint is required for Azure AI Search');
    if (!apiKey) throw new InvalidCredentialsError('apiKey is required for Azure AI Search');
    this.credential = new AzureKeyCredential(apiKey);
    this.indexClient = new SearchIndexClient(endpoint, this.credential);
  }

  private searchClient(index: string): SearchClient<AzureDoc> {
    return this.indexClient.getSearchClient<AzureDoc>(index);
  }

  async createIndex(index: string, mapping?: Record<string, unknown>): Promise<void> {
    const hasFields = !!mapping && Object.prototype.hasOwnProperty.call(mapping, 'fields');
    const definition = hasFields
      ? { ...mapping, name: index }
      : { name: index, fields: [{ name: 'id', type: 'Edm.String', key: true }] };
    try {
      await this.indexClient.createOrUpdateIndex(definition as unknown as SearchIndex);
    } catch (err) {
      wrapProviderError('azure', 'createIndex', err);
    }
  }

  async deleteIndex(index: string): Promise<void> {
    try {
      await this.indexClient.deleteIndex(index);
    } catch (err) {
      wrapProviderError('azure', 'deleteIndex', err);
    }
  }

  async indexExists(index: string): Promise<boolean> {
    try {
      await this.indexClient.getIndex(index);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      wrapProviderError('azure', 'indexExists', err);
    }
  }

  async listIndices(): Promise<string[]> {
    try {
      const names: string[] = [];
      for await (const name of this.indexClient.listIndexesNames()) names.push(name);
      return names;
    } catch (err) {
      wrapProviderError('azure', 'listIndices', err);
    }
  }

  /** Not supported: Azure AI Search has no Elasticsearch-style mapping API. */
  async getMapping(_index: string): Promise<Record<string, unknown>> {
    throw new UnsupportedError('azure', 'getMapping', mappingUnsupportedMessage, mappingUnsupportedAlternative);
  }

  /** Not supported: Azure AI Search has no Elasticsearch-style mapping API. */
  async putMapping(_index: string, _mapping: Record<string, unknown>): Promise<void> {
    throw new UnsupportedError('azure', 'putMapping', mappingUnsupportedMessage, mappingUnsupportedAlternative);
  }

  /** Not supported: Azure AI Search indexing is near-real-time. */
  async refresh(_index: string): Promise<void> {
    throw new UnsupportedError('azure', 'refresh', mappingUnsupportedMessage, mappingUnsupportedAlternative);
  }

  async indexDocument(index: string, id: string, doc: Record<string, unknown>): Promise<void> {
    try {
      await this.searchClient(index).mergeOrUploadDocuments([{ ...doc, id }]);
    } catch (err) {
      wrapProviderError('azure', 'indexDocument', err);
    }
  }

  async getDocument(index: string, id: string): Promise<Record<string, unknown>> {
    try {
      const doc = await this.searchClient(index).getDocument(id);
      return doc as Record<string, unknown>;
    } catch (err) {
      wrapProviderError('azure', 'getDocument', err);
    }
  }

  async updateDocument(index: string, id: string, doc: Record<string, unknown>): Promise<void> {
    try {
      await this.searchClient(index).mergeOrUploadDocuments([{ ...doc, id }]);
    } catch (err) {
      wrapProviderError('azure', 'updateDocument', err);
    }
  }

  async deleteDocument(index: string, id: string): Promise<void> {
    try {
      await this.searchClient(index).deleteDocuments('id', [id]);
    } catch (err) {
      wrapProviderError('azure', 'deleteDocument', err);
    }
  }

  async bulkIndex(index: string, docs: SearchDocument[]): Promise<void> {
    if (docs.length === 0) return;
    try {
      await this.searchClient(index).mergeOrUploadDocuments(docs.map((d) => ({ ...d.doc, id: d.id })));
    } catch (err) {
      wrapProviderError('azure', 'bulkIndex', err);
    }
  }

  /**
   * Runs a query. The query map is translated to the Azure search request: a
   * "search" string is passed through if present, otherwise a match-all ("*") is
   * performed. "top"/"size", "skip"/"from", "orderby" and "select" map to result
   * paging, sorting and projection. Elasticsearch-style DSL under a "query" key
   * cannot be translated and falls back to a match-all search, matching the Go SDK.
   */
  async search(index: string, query: Record<string, unknown>): Promise<SearchResult> {
    try {
      const searchText = typeof query.search === 'string' ? query.search : '*';
      const res = await this.searchClient(index).search(searchText, {
        includeTotalCount: true,
        filter: typeof query.filter === 'string' ? query.filter : undefined,
        top: (query.top ?? query.size) as number | undefined,
        skip: (query.skip ?? query.from) as number | undefined,
        orderBy: toStringArray(query.orderby),
        select: toStringArray(query.select) as never,
      });
      const hits: SearchHit[] = [];
      for await (const r of res.results) {
        const source = r.document as AzureDoc;
        hits.push({ id: typeof source.id === 'string' ? source.id : '', score: r.score, source });
      }
      return { total: res.count ?? hits.length, hits };
    } catch (err) {
      wrapProviderError('azure', 'search', err);
    }
  }

  /** Returns the total document count for the index; the query is ignored, matching the Go SDK. */
  async count(index: string, _query: Record<string, unknown>): Promise<number> {
    try {
      return await this.searchClient(index).getDocumentsCount();
    } catch (err) {
      wrapProviderError('azure', 'count', err);
    }
  }
}
