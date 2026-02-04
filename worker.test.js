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
  CLAUDE_MODEL,
  SUMMARY_WORD_TARGET,
} from './worker.js';

// Import the worker's default export for integration tests
import worker from './worker.js';

// ============ TEST FIXTURES ============

const mockArticles = [
  {
    id: 'article-1',
    title: 'Test Article One',
    content: 'This is the full content of the first test article.',
    site_name: 'The Atlantic',
    source_url: 'https://www.theatlantic.com/article/test-1',
    url: 'https://www.theatlantic.com/article/test-1',
    location: 'feed',
    category: 'article',
  },
  {
    id: 'article-2',
    title: 'Test Article Two',
    content: 'This is the full content of the second test article.',
    source_url: 'https://arstechnica.com/science/test-2',
    url: 'https://arstechnica.com/science/test-2',
    location: 'new',
    category: 'article',
  },
  {
    id: 'article-3',
    title: 'Archived Article',
    content: 'This should be filtered out.',
    site_name: 'TechCrunch',
    location: 'archive',
    category: 'article',
  },
];

const mockClaudeResponse = {
  content: [
    {
      type: 'text',
      text: 'This is a test summary of the article that captures the key points in about thirty seconds of spoken audio.',
    },
  ],
};

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

  it('does not include non-heard prefixed keys', async () => {
    const env = createMockEnv({
      'heard:article-1': '1234567890',
      'later:article-2': '1234567891',
      'other:key': 'value',
    });

    const result = await getHeardIds(env);

    expect(result.size).toBe(1);
    expect(result.has('article-1')).toBe(true);
    expect(result.has('article-2')).toBe(false);
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

// ============ UNIT TESTS: Configuration ============

describe('Configuration', () => {
  it('uses Claude Haiku model', () => {
    expect(CLAUDE_MODEL).toBe('claude-3-haiku-20240307');
  });

  it('targets ~30 second summaries (120 words)', () => {
    expect(SUMMARY_WORD_TARGET).toBe(120);
  });
});

// ============ INTEGRATION TESTS: API Endpoints ============

describe('Worker API Endpoints', () => {
  let originalFetch;
  let mockFetchResponses;

  beforeEach(() => {
    // Save original fetch
    originalFetch = globalThis.fetch;
    mockFetchResponses = {};

    // Mock global fetch
    globalThis.fetch = vi.fn(async (url, options) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      // Mock Readwise API
      if (urlStr.includes('readwise.io/api/v3/list')) {
        return new Response(JSON.stringify({
          results: mockArticles,
        }), { status: 200 });
      }

      // Mock Readwise update
      if (urlStr.includes('readwise.io/api/v3/update')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }

      // Mock Readwise delete
      if (urlStr.includes('readwise.io/api/v3/delete')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }

      // Mock Claude API
      if (urlStr.includes('api.anthropic.com')) {
        return new Response(JSON.stringify(mockClaudeResponse), { status: 200 });
      }

      // Default: pass through or error
      return new Response('Not Found', { status: 404 });
    });
  });

  afterEach(() => {
    // Restore original fetch
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
      expect(html).toContain('Readwise Audio');
    });
  });

  describe('GET /manifest.json', () => {
    it('serves PWA manifest', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/manifest.json');

      const response = await worker.fetch(request, env, {});
      const manifest = await response.json();

      expect(response.status).toBe(200);
      expect(manifest.name).toBe('Readwise Audio');
      expect(manifest.short_name).toBe('RW Audio');
      expect(manifest.display).toBe('standalone');
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
      // Should have 2 articles (article-3 is archived and filtered out)
      expect(data.articles.length).toBe(2);
    });

    it('filters out already-heard articles', async () => {
      const env = createMockEnv({
        'heard:article-1': Date.now().toString(),
      });
      const request = new Request('https://example.com/api/feed');

      const response = await worker.fetch(request, env, {});
      const data = await response.json();

      // Should only have article-2 (article-1 is heard, article-3 is archived)
      expect(data.articles.length).toBe(1);
      expect(data.articles[0].id).toBe('article-2');
    });

    it('includes later articles even if heard', async () => {
      const env = createMockEnv({
        'heard:article-1': Date.now().toString(),
        'later:article-1': Date.now().toString(),
      });
      const request = new Request('https://example.com/api/feed');

      const response = await worker.fetch(request, env, {});
      const data = await response.json();

      // Should have both articles (article-1 is in later list)
      expect(data.articles.length).toBe(2);
      const ids = data.articles.map(a => a.id);
      expect(ids).toContain('article-1');
      expect(ids).toContain('article-2');
    });

    it('returns correct article structure', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/api/feed');

      const response = await worker.fetch(request, env, {});
      const data = await response.json();

      const article = data.articles[0];
      expect(article).toHaveProperty('id');
      expect(article).toHaveProperty('title');
      expect(article).toHaveProperty('source');
      expect(article).toHaveProperty('summary');
      expect(article).toHaveProperty('url');
      expect(article).toHaveProperty('readwise_url');
    });
  });

  describe('POST /api/archive', () => {
    it('marks article as heard and archives in Readwise', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/api/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'article-1' }),
      });

      const response = await worker.fetch(request, env, {});
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify KV was updated
      expect(env.KV.put).toHaveBeenCalledWith(
        'heard:article-1',
        expect.any(String),
        expect.objectContaining({ expirationTtl: expect.any(Number) })
      );

      // Verify Readwise API was called
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('readwise.io/api/v3/update/article-1'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  describe('POST /api/delete', () => {
    it('marks article as heard and deletes from Readwise', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'article-2' }),
      });

      const response = await worker.fetch(request, env, {});
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify KV was updated
      expect(env.KV.put).toHaveBeenCalledWith(
        'heard:article-2',
        expect.any(String),
        expect.any(Object)
      );

      // Verify Readwise delete API was called
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('readwise.io/api/v3/delete/article-2'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('POST /api/later', () => {
    it('adds article to later list and removes from heard', async () => {
      const env = createMockEnv({
        'heard:article-1': Date.now().toString(),
      });
      const request = new Request('https://example.com/api/later', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'article-1' }),
      });

      const response = await worker.fetch(request, env, {});
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify later was added
      expect(env.KV.put).toHaveBeenCalledWith(
        'later:article-1',
        expect.any(String),
        expect.objectContaining({ expirationTtl: expect.any(Number) })
      );

      // Verify heard was removed
      expect(env.KV.delete).toHaveBeenCalledWith('heard:article-1');
    });
  });

  describe('CORS', () => {
    it('handles OPTIONS preflight requests', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/api/feed', {
        method: 'OPTIONS',
      });

      const response = await worker.fetch(request, env, {});

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/unknown/path');

      const response = await worker.fetch(request, env, {});

      expect(response.status).toBe(404);
    });
  });
});

describe('Client-Side Logic Integrity', () => {
  it('ensures critical functions call stop()', async () => {
    const request = new Request('https://example.com/');
    const env = createMockEnv();
    const response = await worker.fetch(request, env, {});
    const html = await response.text();

    // Check actions stop playback
    expect(html).toMatch(/function archiveArticle\(\)\s*\{[^}]*stop\(\);/);
    expect(html).toMatch(/function deleteArticle\(\)\s*\{[^}]*stop\(\);/);
    expect(html).toMatch(/function laterArticle\(\)\s*\{[^}]*stop\(\);/);
    expect(html).toMatch(/function readFullArticle\(\)\s*\{[^}]*stop\(\);/);
  });

  it('contains correct deep link scheme', async () => {
    const request = new Request('https://example.com/');
    const env = createMockEnv();
    const response = await worker.fetch(request, env, {});
    const html = await response.text();

    expect(html).toContain('wiseread://open/private://read/');
  });
});

// ============ ERROR HANDLING TESTS ============

describe('Error Handling', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('handles Readwise API errors gracefully', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('Unauthorized', { status: 401 });
    });

    const env = createMockEnv();
    const request = new Request('https://example.com/api/feed');

    const response = await worker.fetch(request, env, {});
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.articles).toEqual([]);
  });

  it('handles Claude API errors gracefully', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('readwise.io')) {
        return new Response(JSON.stringify({
          results: [mockArticles[0]],
        }), { status: 200 });
      }
      if (urlStr.includes('anthropic.com')) {
        return new Response('Rate limited', { status: 429 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const env = createMockEnv();
    const request = new Request('https://example.com/api/feed');

    const response = await worker.fetch(request, env, {});
    const data = await response.json();

    // Should return empty articles but not crash
    expect(response.status).toBe(200);
    expect(data.articles).toEqual([]);
  });
});

// ============ EDGE CASE TESTS ============

describe('Edge Cases', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('readwise.io/api/v3/list')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response('OK', { status: 200 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('handles empty Readwise feed', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/api/feed');

    const response = await worker.fetch(request, env, {});
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.articles).toEqual([]);
  });

  it('handles articles with missing fields', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('readwise.io/api/v3/list')) {
        return new Response(JSON.stringify({
          results: [{
            id: 'minimal-article',
            location: 'feed',
            category: 'article',
            // Missing: title, content, source_url, site_name
          }],
        }), { status: 200 });
      }
      if (urlStr.includes('anthropic.com')) {
        return new Response(JSON.stringify(mockClaudeResponse), { status: 200 });
      }
      return new Response('OK', { status: 200 });
    });

    const env = createMockEnv();
    const request = new Request('https://example.com/api/feed');

    const response = await worker.fetch(request, env, {});
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.articles.length).toBe(1);
    expect(data.articles[0].title).toBe('Untitled');
    expect(data.articles[0].source).toBe('Unknown source');
  });
});
