import { UnsupportedError } from '../../errors.js';
import type { Search, SearchDocument, SearchResult } from '../types/search.js';

function searchUnsupported(op: string): UnsupportedError {
  return new UnsupportedError(
    'gcp',
    op,
    'GCP has no managed OpenSearch/Elasticsearch service.',
    'Run Elasticsearch/OpenSearch on GKE/Compute, or use Vertex AI Search.',
  );
}

/** GCP has no managed OpenSearch/Elasticsearch-equivalent service; every operation throws UnsupportedError. */
export class GcpSearch implements Search {
  async createIndex(index: string, mapping?: Record<string, unknown>): Promise<void> {
    throw searchUnsupported('createIndex');
  }

  async deleteIndex(index: string): Promise<void> {
    throw searchUnsupported('deleteIndex');
  }

  async indexExists(index: string): Promise<boolean> {
    throw searchUnsupported('indexExists');
  }

  async listIndices(): Promise<string[]> {
    throw searchUnsupported('listIndices');
  }

  async getMapping(index: string): Promise<Record<string, unknown>> {
    throw searchUnsupported('getMapping');
  }

  async putMapping(index: string, mapping: Record<string, unknown>): Promise<void> {
    throw searchUnsupported('putMapping');
  }

  async refresh(index: string): Promise<void> {
    throw searchUnsupported('refresh');
  }

  async indexDocument(index: string, id: string, doc: Record<string, unknown>): Promise<void> {
    throw searchUnsupported('indexDocument');
  }

  async getDocument(index: string, id: string): Promise<Record<string, unknown>> {
    throw searchUnsupported('getDocument');
  }

  async updateDocument(index: string, id: string, doc: Record<string, unknown>): Promise<void> {
    throw searchUnsupported('updateDocument');
  }

  async deleteDocument(index: string, id: string): Promise<void> {
    throw searchUnsupported('deleteDocument');
  }

  async bulkIndex(index: string, docs: SearchDocument[]): Promise<void> {
    throw searchUnsupported('bulkIndex');
  }

  async search(index: string, query: Record<string, unknown>): Promise<SearchResult> {
    throw searchUnsupported('search');
  }

  async count(index: string, query: Record<string, unknown>): Promise<number> {
    throw searchUnsupported('count');
  }
}
