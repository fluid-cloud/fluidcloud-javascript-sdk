/** A single document for bulk indexing. */
export interface SearchDocument {
  id: string;
  doc: Record<string, unknown>;
}

/** A single matched document. */
export interface SearchHit {
  id: string;
  score: number;
  source: Record<string, unknown>;
}

/** Provider-agnostic view of a search response. */
export interface SearchResult {
  total: number;
  hits: SearchHit[];
}

/**
 * Unified managed search. Maps to AWS OpenSearch and OCI Search with OpenSearch
 * (both speak the OpenSearch REST API) and Azure AI Search (a different REST API
 * where index, document and query ops are mapped and raw-DSL/mapping ops are
 * emulated or throw UnsupportedError).
 */
export interface Search {
  /** Creates an index with an optional mapping. */
  createIndex(index: string, mapping?: Record<string, unknown>): Promise<void>;

  /** Deletes an index. */
  deleteIndex(index: string): Promise<void>;

  /** Reports whether an index exists. */
  indexExists(index: string): Promise<boolean>;

  /** Lists index names. */
  listIndices(): Promise<string[]>;

  /** Reads an index mapping. */
  getMapping(index: string): Promise<Record<string, unknown>>;

  /** Writes an index mapping. */
  putMapping(index: string, mapping: Record<string, unknown>): Promise<void>;

  /** Makes recent writes searchable. */
  refresh(index: string): Promise<void>;

  /** Indexes one document under an id. */
  indexDocument(index: string, id: string, doc: Record<string, unknown>): Promise<void>;

  /** Reads one document. */
  getDocument(index: string, id: string): Promise<Record<string, unknown>>;

  /** Partially updates one document. */
  updateDocument(index: string, id: string, doc: Record<string, unknown>): Promise<void>;

  /** Deletes one document. */
  deleteDocument(index: string, id: string): Promise<void>;

  /** Indexes many documents in one round trip. */
  bulkIndex(index: string, docs: SearchDocument[]): Promise<void>;

  /** Runs a query. */
  search(index: string, query: Record<string, unknown>): Promise<SearchResult>;

  /** Counts documents matching a query. */
  count(index: string, query: Record<string, unknown>): Promise<number>;
}
