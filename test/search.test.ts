import { describe, expect, it, vi, beforeEach } from 'vitest';

const { osInstance, ClientMock, ClientCtor } = vi.hoisted(() => {
  const instance = {
    indices: {
      create: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      getMapping: vi.fn(),
      putMapping: vi.fn(),
      refresh: vi.fn(),
    },
    cat: { indices: vi.fn() },
    index: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    bulk: vi.fn(),
    search: vi.fn(),
    count: vi.fn(),
  };
  const ClientMock = vi.fn();
  class ClientCtor {
    constructor(opts: unknown) {
      ClientMock(opts);
      return instance as unknown as ClientCtor;
    }
  }
  return { osInstance: instance, ClientMock, ClientCtor };
});

const { azureIndexClientInstance, azureSearchClientInstance, SearchIndexClientMock, SearchIndexClientCtor } =
  vi.hoisted(() => {
    const searchClientInstance = {
      mergeOrUploadDocuments: vi.fn(),
      getDocument: vi.fn(),
      deleteDocuments: vi.fn(),
      search: vi.fn(),
      getDocumentsCount: vi.fn(),
    };
    const indexClientInstance = {
      createOrUpdateIndex: vi.fn(),
      deleteIndex: vi.fn(),
      getIndex: vi.fn(),
      listIndexesNames: vi.fn(),
      getSearchClient: vi.fn(() => searchClientInstance),
    };
    const SearchIndexClientMock = vi.fn();
    class SearchIndexClientCtor {
      constructor(endpoint: unknown, credential: unknown) {
        SearchIndexClientMock(endpoint, credential);
        return indexClientInstance as unknown as SearchIndexClientCtor;
      }
    }
    return {
      azureIndexClientInstance: indexClientInstance,
      azureSearchClientInstance: searchClientInstance,
      SearchIndexClientMock,
      SearchIndexClientCtor,
    };
  });

vi.mock('@opensearch-project/opensearch', () => ({ Client: ClientCtor }));
vi.mock('@azure/search-documents', () => ({
  AzureKeyCredential: vi.fn(),
  SearchIndexClient: SearchIndexClientCtor,
  SearchClient: vi.fn(),
}));

import { OpenSearchAws } from '../src/provider/aws/search.js';
import { OpenSearchOci } from '../src/provider/oci/search.js';
import { AiSearch } from '../src/provider/azure/search.js';
import { GcpSearch } from '../src/provider/gcp/search.js';
import { InvalidCredentialsError, ProviderError, UnsupportedError } from '../src/errors.js';
import type { AwsCredentials } from '../src/credentials/index.js';

function resetOsMocks(): void {
  Object.values(osInstance.indices).forEach((fn) => fn.mockReset());
  osInstance.cat.indices.mockReset();
  osInstance.index.mockReset();
  osInstance.get.mockReset();
  osInstance.update.mockReset();
  osInstance.delete.mockReset();
  osInstance.bulk.mockReset();
  osInstance.search.mockReset();
  osInstance.count.mockReset();
}

function resetAzureMocks(): void {
  azureSearchClientInstance.mergeOrUploadDocuments.mockReset();
  azureSearchClientInstance.getDocument.mockReset();
  azureSearchClientInstance.deleteDocuments.mockReset();
  azureSearchClientInstance.search.mockReset();
  azureSearchClientInstance.getDocumentsCount.mockReset();
  azureIndexClientInstance.createOrUpdateIndex.mockReset();
  azureIndexClientInstance.deleteIndex.mockReset();
  azureIndexClientInstance.getIndex.mockReset();
  azureIndexClientInstance.listIndexesNames.mockReset();
}

describe('OpenSearchOci (shared OpenSearch base)', () => {
  const client = () => new OpenSearchOci('https://search.oci.example', 'user', 'pass');

  beforeEach(() => {
    ClientMock.mockClear();
    resetOsMocks();
  });

  it('authenticates with HTTP basic auth', () => {
    client();
    expect(ClientMock).toHaveBeenCalledWith({
      node: 'https://search.oci.example',
      auth: { username: 'user', password: 'pass' },
    });
  });

  it('throws InvalidCredentialsError when no endpoint is given', () => {
    expect(() => new OpenSearchOci('', 'user', 'pass')).toThrow(InvalidCredentialsError);
  });

  it('createIndex sends the mapping as the request body when provided', async () => {
    osInstance.indices.create.mockResolvedValue({});
    await client().createIndex('idx', { settings: { number_of_shards: 1 } });
    expect(osInstance.indices.create).toHaveBeenCalledWith({
      index: 'idx',
      body: { settings: { number_of_shards: 1 } },
    });
  });

  it('createIndex omits the body when no mapping is given', async () => {
    osInstance.indices.create.mockResolvedValue({});
    await client().createIndex('idx');
    expect(osInstance.indices.create).toHaveBeenCalledWith({ index: 'idx', body: undefined });
  });

  it('indexExists returns false for a missing index without throwing', async () => {
    osInstance.indices.exists.mockResolvedValue({ body: false });
    await expect(client().indexExists('idx')).resolves.toBe(false);
  });

  it('indexExists returns true for an existing index', async () => {
    osInstance.indices.exists.mockResolvedValue({ body: true });
    await expect(client().indexExists('idx')).resolves.toBe(true);
  });

  it('listIndices maps cat rows to index names', async () => {
    osInstance.cat.indices.mockResolvedValue({ body: [{ index: 'a' }, { index: 'b' }] });
    await expect(client().listIndices()).resolves.toEqual(['a', 'b']);
    expect(osInstance.cat.indices).toHaveBeenCalledWith({ format: 'json' });
  });

  it('bulkIndex builds alternating meta/doc entries, keyed by id when given', async () => {
    osInstance.bulk.mockResolvedValue({});
    await client().bulkIndex('idx', [
      { id: '1', doc: { a: 1 } },
      { id: '', doc: { b: 2 } },
    ]);
    expect(osInstance.bulk).toHaveBeenCalledWith({
      index: 'idx',
      body: [{ index: { _id: '1' } }, { a: 1 }, { index: {} }, { b: 2 }],
    });
  });

  it('bulkIndex is a no-op for an empty document list', async () => {
    await client().bulkIndex('idx', []);
    expect(osInstance.bulk).not.toHaveBeenCalled();
  });

  it('search maps OpenSearch hits and total into the unified shape', async () => {
    osInstance.search.mockResolvedValue({
      body: { hits: { total: { value: 2 }, hits: [{ _id: '1', _score: 1.5, _source: { a: 1 } }] } },
    });
    const result = await client().search('idx', { query: { match_all: {} } });
    expect(osInstance.search).toHaveBeenCalledWith({ index: 'idx', body: { query: { match_all: {} } } });
    expect(result).toEqual({ total: 2, hits: [{ id: '1', score: 1.5, source: { a: 1 } }] });
  });

  it('count returns the count field of the response', async () => {
    osInstance.count.mockResolvedValue({ body: { count: 5 } });
    await expect(client().count('idx', {})).resolves.toBe(5);
  });

  it('getDocument on a missing document throws ProviderError, not NotFoundError, matching the Go SDK', async () => {
    osInstance.get.mockRejectedValue(new Error('opensearch error response: 404 Not Found'));
    await expect(client().getDocument('idx', 'missing')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('OpenSearchAws', () => {
  const creds: AwsCredentials = { accessKey: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1' };

  beforeEach(() => {
    ClientMock.mockClear();
    resetOsMocks();
  });

  it('constructs an OpenSearch client signed with SigV4 for the "es" service', () => {
    new OpenSearchAws(creds, 'https://search.us-east-1.es.amazonaws.com');
    expect(ClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        node: 'https://search.us-east-1.es.amazonaws.com',
        Transport: expect.any(Function),
        Connection: expect.any(Function),
      }),
    );
  });

  it('throws InvalidCredentialsError when no endpoint is given', () => {
    expect(() => new OpenSearchAws(creds, '')).toThrow(InvalidCredentialsError);
  });

  it('delegates to the shared OpenSearch implementation', async () => {
    osInstance.indices.delete.mockResolvedValue({});
    await new OpenSearchAws(creds, 'https://search.example').deleteIndex('idx');
    expect(osInstance.indices.delete).toHaveBeenCalledWith({ index: 'idx' });
  });
});

describe('AiSearch (Azure)', () => {
  const client = () => new AiSearch('https://example.search.windows.net', 'api-key');

  beforeEach(() => {
    resetAzureMocks();
  });

  it('throws InvalidCredentialsError when endpoint or apiKey are missing', () => {
    expect(() => new AiSearch('', 'key')).toThrow(InvalidCredentialsError);
    expect(() => new AiSearch('https://example.search.windows.net', '')).toThrow(InvalidCredentialsError);
  });

  it('createIndex builds a minimal id-keyed index when no fields are given', async () => {
    azureIndexClientInstance.createOrUpdateIndex.mockResolvedValue({});
    await client().createIndex('idx');
    expect(azureIndexClientInstance.createOrUpdateIndex).toHaveBeenCalledWith({
      name: 'idx',
      fields: [{ name: 'id', type: 'Edm.String', key: true }],
    });
  });

  it('createIndex passes a full index definition through when "fields" is present', async () => {
    azureIndexClientInstance.createOrUpdateIndex.mockResolvedValue({});
    const mapping = { fields: [{ name: 'id', type: 'Edm.String', key: true }], corsOptions: {} };
    await client().createIndex('idx', mapping);
    expect(azureIndexClientInstance.createOrUpdateIndex).toHaveBeenCalledWith({ ...mapping, name: 'idx' });
  });

  it('indexExists returns false on a 404 without throwing', async () => {
    azureIndexClientInstance.getIndex.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    await expect(client().indexExists('idx')).resolves.toBe(false);
  });

  it('indexExists returns true when the index is found', async () => {
    azureIndexClientInstance.getIndex.mockResolvedValue({});
    await expect(client().indexExists('idx')).resolves.toBe(true);
  });

  it('getMapping, putMapping and refresh are unsupported', async () => {
    await expect(client().getMapping('idx')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(client().putMapping('idx', {})).rejects.toBeInstanceOf(UnsupportedError);
    await expect(client().refresh('idx')).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('search translates size/from/orderby/select and defaults to a match-all query', async () => {
    azureSearchClientInstance.search.mockResolvedValue({
      count: 1,
      results: [{ score: 2.5, document: { id: 'doc1', title: 'x' } }],
    });
    const result = await client().search('idx', {
      filter: "category eq 'a'",
      size: 10,
      from: 5,
      orderby: 'rating desc',
      select: ['title', 'id'],
    });
    expect(azureSearchClientInstance.search).toHaveBeenCalledWith('*', {
      includeTotalCount: true,
      filter: "category eq 'a'",
      top: 10,
      skip: 5,
      orderBy: ['rating desc'],
      select: ['title', 'id'],
    });
    expect(result).toEqual({ total: 1, hits: [{ id: 'doc1', score: 2.5, source: { id: 'doc1', title: 'x' } }] });
  });

  it('search passes the "search" string through when given, instead of defaulting to match-all', async () => {
    azureSearchClientInstance.search.mockResolvedValue({ count: 0, results: [] });
    await client().search('idx', { search: 'hello' });
    expect(azureSearchClientInstance.search).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ includeTotalCount: true }),
    );
  });

  it('count ignores the query and returns the document count', async () => {
    azureSearchClientInstance.getDocumentsCount.mockResolvedValue(42);
    await expect(client().count('idx', { query: { match_all: {} } })).resolves.toBe(42);
    expect(azureSearchClientInstance.getDocumentsCount).toHaveBeenCalledWith();
  });

  it('bulkIndex merges every document, keyed by id', async () => {
    azureSearchClientInstance.mergeOrUploadDocuments.mockResolvedValue({});
    await client().bulkIndex('idx', [{ id: '1', doc: { a: 1 } }]);
    expect(azureSearchClientInstance.mergeOrUploadDocuments).toHaveBeenCalledWith([{ a: 1, id: '1' }]);
  });
});

describe('GcpSearch', () => {
  const svc = new GcpSearch();
  const cases: [string, () => Promise<unknown>][] = [
    ['createIndex', () => svc.createIndex('idx')],
    ['deleteIndex', () => svc.deleteIndex('idx')],
    ['indexExists', () => svc.indexExists('idx')],
    ['listIndices', () => svc.listIndices()],
    ['getMapping', () => svc.getMapping('idx')],
    ['putMapping', () => svc.putMapping('idx', {})],
    ['refresh', () => svc.refresh('idx')],
    ['indexDocument', () => svc.indexDocument('idx', '1', {})],
    ['getDocument', () => svc.getDocument('idx', '1')],
    ['updateDocument', () => svc.updateDocument('idx', '1', {})],
    ['deleteDocument', () => svc.deleteDocument('idx', '1')],
    ['bulkIndex', () => svc.bulkIndex('idx', [])],
    ['search', () => svc.search('idx', {})],
    ['count', () => svc.count('idx', {})],
  ];

  it.each(cases)('%s throws UnsupportedError', async (_name, fn) => {
    await expect(fn()).rejects.toBeInstanceOf(UnsupportedError);
  });
});
