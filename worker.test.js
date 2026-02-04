/**
 * Tests for Readwise Audio Summary Worker
 *
 * Run with: npm test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractSource,
  getHeardIds,
  getLaterIds,
} from './worker.js';
import {
  CLAUDE_MODEL,
  SUMMARY_WORD_TARGET,
} from './config.js';

// Import the worker's default export for integration tests
import worker from './worker.js';

// Import Mocks
import { mockReadwiseList, mockReadwiseUpdate, mockReadwiseDelete } from './mocks/readwise-api.js';
import { mockClaudeResponse } from './mocks/claude-api.js';
import { mockTTSResponse } from './mocks/tts-api.js';

// ============ MOCK HELPERS ============

function createMockKV(initialData = {}) {
  const store = { ...initialData };

  return {
    get: vi.fn(async (key) => store[key] || null),
    put: vi.fn(async (key, value, options) => {
      store[key] = value;
    }),
    delete: vi.fn(async (key) => {
      delete store[key];
    }),
    list: vi.fn(async ({ prefix }) => {
      const keys = Object.keys(store)
        .filter(k => k.startsWith(prefix))
        .map(name => ({ name }));
      return { keys };
    }),
    _store: store, // For test inspection
  };
}

function createMockEnv(kvData = {}) {
  return {
    READWISE_TOKEN: 'test-readwise-token',
    CLAUDE_API_KEY: 'test-claude-key',
    OPENAI_API_KEY: 'test-openai-key',
    KV: createMockKV(kvData),
  };
}

// ============ UNIT TESTS: extractSource ============

describe('extractSource', () => {
  it('returns site_name when present', () => {
    const article = { site_name: 'The Atlantic' };
    expect(extractSource(article)).toBe('The Atlantic');
  });

  it('extracts hostname from source_url when site_name is missing', () => {
    const article = { source_url: 'https://www.example.com/article/123' };
    expect(extractSource(article)).toBe('example.com');
  });

  it('removes www. prefix from hostname', () => {
    const article = { source_url: 'https://www.nytimes.com/2024/test' };
    expect(extractSource(article)).toBe('nytimes.com');
  });

  it('handles URLs without www.', () => {
    const article = { source_url: 'https://arstechnica.com/science/test' };
    expect(extractSource(article)).toBe('arstechnica.com');
  });

  it('returns "Unknown source" when no source info available', () => {
    const article = {};
    expect(extractSource(article)).toBe('Unknown source');
  });

  it('returns "Unknown source" for invalid URLs', () => {
    const article = { source_url: 'not-a-valid-url' };
    expect(extractSource(article)).toBe('Unknown source');
  });

  it('prefers site_name over source_url', () => {
    const article = {
      site_name: 'Custom Name',
      source_url: 'https://example.com/article',
    };
    expect(extractSource(article)).toBe('Custom Name');
  });

  it('handles subdomains correctly', () => {
    const article = { source_url: 'https://blog.example.com/post/1' };
    expect(extractSource(article)).toBe('blog.example.com');
  });
});

// ============ UNIT TESTS: getHeardIds ============

describe('getHeardIds', () => {
  it('returns empty Set when KV has no heard entries', async () => {
    const env = createMockEnv();
    const result = await getHeardIds(env);

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it('returns Set with heard article IDs', async () => {
    const env = createMockEnv({
      'heard:article-1': '1234567890',
      'heard:article-2': '1234567891',
    });

    const result = await getHeardIds(env);

    expect(result.size).toBe(2);
    expect(result.has('article-1')).toBe(true);
    expect(result.has('article-2')).toBe(true);
  });
});

// ============ UNIT TESTS: getLaterIds ============

describe('getLaterIds', () => {
  it('returns empty Set when KV has no later entries', async () => {
    const env = createMockEnv();
    const result = await getLaterIds(env);

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it('returns Set with later article IDs', async () => {
    const env = createMockEnv({
      'later:article-1': '1234567890',
      'later:article-3': '1234567892',
    });

    const result = await getLaterIds(env);

    expect(result.size).toBe(2);
    expect(result.has('article-1')).toBe(true);
    expect(result.has('article-3')).toBe(true);
  });
});

// ============ INTEGRATION TESTS: API Endpoints ============

describe('Worker API Endpoints', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;

    // Route requests to appropriate mocks
    globalThis.fetch = vi.fn(async (url, options) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const headers = options?.headers || {};

      // Request Wrappers
      const req = {
        url: urlStr,
        headers: new Headers(headers),
        json: async () => JSON.parse(options?.body || '{}'),
      };

      // 1. Readwise
      if (urlStr.includes('readwise.io/api/v3/list')) {
        return mockReadwiseList(req);
      }
      if (urlStr.includes('readwise.io/api/v3/update')) {
        return mockReadwiseUpdate(req);
      }
      if (urlStr.includes('readwise.io/api/v3/delete')) {
        return mockReadwiseDelete(req);
      }

      // 2. Claude (Anthropic)
      if (urlStr.includes('api.anthropic.com')) {
        return mockClaudeResponse(req);
      }

      // 3. OpenAI TTS
      if (urlStr.includes('api.openai.com')) {
        return mockTTSResponse(req);
      }

      // 4. Fallback
      return new Response('Not Found', { status: 404 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it('serves HTML page', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/');
      const response = await worker.fetch(request, env, {});

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html');
      const html = await response.text();
      expect(html).toContain('<!DOCTYPE html>');
    });
  });

  describe('GET /api/feed', () => {
    it('fetches and summarizes articles', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/api/feed');
      const response = await worker.fetch(request, env, {});
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.articles).toBeDefined();
      expect(data.articles.length).toBeGreaterThan(0);

      // Check for field persistence from mock data
      const sample = data.articles.find(a => a.id === '01kg2v32rr4p7bd5zh4zzsbx9g');
      expect(sample).toBeDefined();
      expect(sample.title).toBe('Handling ICErubes Safely');
    });

    it('filters out heard articles', async () => {
      const env = createMockEnv({
        'heard:01kg2v32rr4p7bd5zh4zzsbx9g': Date.now().toString(),
      });
      const request = new Request('https://example.com/api/feed');
      const response = await worker.fetch(request, env, {});
      const data = await response.json();

      const ids = data.articles.map(a => a.id);
      expect(ids).not.toContain('01kg2v32rr4p7bd5zh4zzsbx9g');
    });
  });

  describe('POST /api/tts', () => {
    it('returns audio blob from mock', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/api/tts', {
        method: 'POST',
        body: JSON.stringify({ text: 'Hello world', voice: 'alloy' })
      });
      const response = await worker.fetch(request, env, {});

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('audio/mpeg');

      const blob = await response.arrayBuffer();
      expect(blob.byteLength).toBeGreaterThan(10);
    });
  });

  describe('POST /api/archive', () => {
    it('calls readwise update mock', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/api/archive', {
        method: 'POST',
        body: JSON.stringify({ id: '01kg2v32rr4p7bd5zh4zzsbx9g' })
      });
      const response = await worker.fetch(request, env, {});
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(env.KV.put).toHaveBeenCalledWith(
        'heard:01kg2v32rr4p7bd5zh4zzsbx9g',
        expect.any(String),
        expect.any(Object)
      );
    });
  });
});

