/**
 * Readwise Audio Summary Worker v3
 *
 * Features:
 * - Light theme UI
 * - Feed/Library/All toggle
 * - Summary caching (saves Claude API costs)
 * - OpenAI TTS with voice selection
 * - Story list view
 * - Read full article aloud
 */

// ============ CONFIGURATION ============

export const CLAUDE_MODEL = 'claude-3-haiku-20240307';
export const SUMMARY_WORD_TARGET = 120;
export const MAX_ARTICLES = 50;
export const SUMMARY_CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

export const SYSTEM_PROMPT = `You are a concise audio news summarizer. Create a spoken summary of the article that:
- Is approximately ${SUMMARY_WORD_TARGET} words (about 30 seconds when read aloud)
- Captures the key insight or news
- Is written for listening (natural speech, no bullet points or formatting)
- Starts directly with the content (no "This article discusses...")
- Uses simple, clear language

Respond with ONLY the summary text, nothing else.`;

// ============ MAIN HANDLER ============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/' || path.endsWith('/index.html')) {
        return await serveHTML(env);
      }
      if (path.includes('/api/feed')) {
        return await handleFeed(request, env, corsHeaders);
      }
      if (path.includes('/api/tts') && request.method === 'POST') {
        return await handleTTS(request, env, corsHeaders);
      }
      if (path.includes('/api/archive') && request.method === 'POST') {
        return await handleArchive(request, env, corsHeaders);
      }
      if (path.includes('/api/delete') && request.method === 'POST') {
        return await handleDelete(request, env, corsHeaders);
      }
      if (path.includes('/api/later') && request.method === 'POST') {
        return await handleLater(request, env, corsHeaders);
      }
      if (path === '/manifest.json') {
        return serveManifest();
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

// ============ API HANDLERS ============

async function handleFeed(request, env, corsHeaders) {
  const url = new URL(request.url);
  const location = url.searchParams.get('location') || 'all'; // 'feed', 'library', 'all'

  // 1. Fetch articles from Readwise Reader
  const articles = await fetchAllReadwiseArticles(env, location);

  // 2. Get heard/later articles from KV
  const heardIds = await getHeardIds(env);
  const laterIds = await getLaterIds(env);

  // 3. Filter: include if not heard, OR if in later list
  const newArticles = articles.filter(article => {
    const isHeard = heardIds.has(article.id);
    const isLater = laterIds.has(article.id);
    return !isHeard || isLater;
  });

  // 4. Summarize each article (with caching!)
  const summaries = [];
  for (const article of newArticles.slice(0, MAX_ARTICLES)) {
    try {
      const summary = await getCachedOrSummarize(article, env);
      summaries.push({
        id: article.id,
        title: article.title || 'Untitled',
        source: extractSource(article),
        summary: summary,
        content: article.content || article.html || article.text || '',
        url: article.url,
        readwise_url: `https://readwise.io/reader/document/${article.id}`,
        original_url: article.source_url || article.url,
        word_count: (article.content || '').split(/\s+/).length,
        location: article.location,
      });

      if (laterIds.has(article.id)) {
        await env.KV.delete(`later:${article.id}`);
      }
    } catch (error) {
      console.error(`Failed to summarize article ${article.id}:`, error);
    }
  }

  return new Response(JSON.stringify({
    articles: summaries,
    total_available: newArticles.length,
    location: location,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleTTS(request, env, corsHeaders) {
  const { text, voice = 'alloy' } = await request.json();

  // Sanity check for API key
  console.log('API Key starts with sk-:', env.OPENAI_API_KEY?.startsWith('sk-'));

  if (!env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ use_browser_tts: true, text }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: text.slice(0, 4096),
      voice: voice,
      format: 'mp3',
    }),
  });

  if (!response.ok) {
    console.error('OpenAI TTS error:', await response.text());
    return new Response(JSON.stringify({ use_browser_tts: true, text }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Stream the response directly to the client
  return new Response(response.body, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'audio/mpeg',
    },
  });
}

async function handleArchive(request, env, corsHeaders) {
  const { id } = await request.json();
  await env.KV.put(`heard:${id}`, Date.now().toString(), { expirationTtl: 60 * 60 * 24 * 30 });
  await updateReadwiseDocument(id, { location: 'archive' }, env);
  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleDelete(request, env, corsHeaders) {
  const { id } = await request.json();
  await env.KV.put(`heard:${id}`, Date.now().toString(), { expirationTtl: 60 * 60 * 24 * 30 });
  await deleteReadwiseDocument(id, env);
  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleLater(request, env, corsHeaders) {
  const { id } = await request.json();
  await env.KV.put(`later:${id}`, Date.now().toString(), { expirationTtl: 60 * 60 * 24 * 7 });
  await env.KV.delete(`heard:${id}`);
  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ============ READWISE API ============

async function fetchAllReadwiseArticles(env, locationFilter) {
  const allArticles = [];
  let nextCursor = null;
  let pageCount = 0;
  const maxPages = 10;

  do {
    // Rate limiting delay between pages
    if (pageCount > 0) await new Promise(r => setTimeout(r, 1000));

    const url = new URL('https://readwise.io/api/v3/list/');
    if (nextCursor) url.searchParams.set('pageCursor', nextCursor);

    // We fetch globally and filter client-side to ensure we get 'new' AND 'feed' for the Feed view,
    // and 'later' AND 'shortlist' for the Library view.
    // Strict client-side filtering + sorting handles the presentation.

    let response;
    let retries = 3;
    while (retries > 0) {
      response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Token ${env.READWISE_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 429) {
        const resetTime = parseInt(response.headers.get('Retry-After')) || 5;
        console.log(`Rate limited. Waiting ${resetTime}s...`);
        await new Promise(r => setTimeout(r, resetTime * 1000));
        retries--;
        continue;
      }
      break;
    }

    if (!response.ok) throw new Error(`Readwise API error: ${response.status}`);

    const data = await response.json();

    // Client-side cleanup and strict verification
    const articles = (data.results || []).filter(doc => {
      if (doc.category !== 'article') return false;
      if (doc.location === 'archive') return false;

      if (locationFilter === 'feed') {
        return doc.location === 'new' || doc.location === 'feed';
      } else if (locationFilter === 'library') {
        return doc.location === 'later' || doc.location === 'shortlist';
      }
      return true;
    });

    allArticles.push(...articles);
    nextCursor = data.nextPageCursor;
    pageCount++;

    if (allArticles.length >= MAX_ARTICLES || pageCount >= maxPages) break;
  } while (nextCursor);

  // Strict Sort: Recent -> Old
  allArticles.sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at));

  return allArticles;
}

async function updateReadwiseDocument(id, updates, env) {
  const response = await fetch(`https://readwise.io/api/v3/update/${id}/`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Token ${env.READWISE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  if (!response.ok) throw new Error(`Readwise update error: ${response.status}`);
  return response.json();
}

async function deleteReadwiseDocument(id, env) {
  const response = await fetch(`https://readwise.io/api/v3/delete/${id}/`, {
    method: 'DELETE',
    headers: { 'Authorization': `Token ${env.READWISE_TOKEN}` },
  });
  if (!response.ok && response.status !== 404) throw new Error(`Readwise delete error: ${response.status}`);
  return true;
}

// ============ SUMMARY CACHING ============

async function getCachedOrSummarize(article, env) {
  const cacheKey = `summary:${article.id}`;

  // Check cache first
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    console.log(`Cache hit for article ${article.id}`);
    return cached;
  }

  // Generate new summary
  console.log(`Cache miss for article ${article.id}, generating...`);
  const summary = await summarizeArticle(article, env);

  // Cache the summary
  await env.KV.put(cacheKey, summary, { expirationTtl: SUMMARY_CACHE_TTL });

  return summary;
}

async function summarizeArticle(article, env) {
  const content = article.content || article.summary || article.notes || '';
  const title = article.title || 'Untitled';
  const source = extractSource(article);

  const userPrompt = `Article from ${source}:
Title: ${title}

Content:
${content.slice(0, 8000)}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// ============ HELPERS ============

export function extractSource(article) {
  if (article.site_name) return article.site_name;
  if (article.source_url) {
    try {
      return new URL(article.source_url).hostname.replace('www.', '');
    } catch {
      return 'Unknown source';
    }
  }
  return 'Unknown source';
}

export async function getHeardIds(env) {
  const list = await env.KV.list({ prefix: 'heard:' });
  return new Set(list.keys.map(k => k.name.replace('heard:', '')));
}

export async function getLaterIds(env) {
  const list = await env.KV.list({ prefix: 'later:' });
  return new Set(list.keys.map(k => k.name.replace('later:', '')));
}

// ============ STATIC CONTENT ============

function serveManifest() {
  return new Response(JSON.stringify({
    name: 'Readwise Audio',
    short_name: 'RW Audio',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8f9fa',
    theme_color: '#e94560',
    icons: [{
      src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23e94560" width="100" height="100" rx="20"/><text x="50" y="65" text-anchor="middle" font-size="50" fill="white">🎧</text></svg>',
      sizes: '192x192',
      type: 'image/svg+xml',
    }],
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function serveHTML(env) {
  return new Response(getHTMLContent(), { headers: { 'Content-Type': 'text/html' } });
}

function getHTMLContent() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="theme-color" content="#f8f9fa">
  <title>Readwise Audio</title>
  <link rel="manifest" href="/manifest.json">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f9fa;
      color: #1a1a2e;
      min-height: 100vh;
      padding: 20px;
      padding-top: max(20px, env(safe-area-inset-top));
      padding-bottom: max(20px, env(safe-area-inset-bottom));
    }

    .container { max-width: 500px; margin: 0 auto; }

    header { text-align: center; margin-bottom: 20px; }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 5px; color: #1a1a2e; }
    .status { font-size: 14px; color: #666; }

    /* Tabs */
    .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
    .tab {
      flex: 1; padding: 12px; border: none; border-radius: 10px;
      background: #fff; color: #666; font-size: 14px; font-weight: 500;
      cursor: pointer; transition: all 0.2s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .tab.active { background: #e94560; color: #fff; }

    /* Source Toggle */
    .source-toggle {
      display: flex; gap: 6px; margin-bottom: 16px;
      background: #fff; padding: 6px; border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .source-btn {
      flex: 1; padding: 10px 8px; border: none; border-radius: 8px;
      background: transparent; color: #666; font-size: 12px; font-weight: 500;
      cursor: pointer; transition: all 0.2s;
    }
    .source-btn.active { background: #e94560; color: #fff; }

    /* Article List */
    .article-list { max-height: 400px; overflow-y: auto; margin-bottom: 16px; }
    .article-item {
      padding: 16px; background: #fff; border-radius: 12px;
      margin-bottom: 8px; cursor: pointer; transition: all 0.2s;
      border: 2px solid transparent;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .article-item:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
    .article-item.active { border-color: #e94560; }
    .article-item.played { opacity: 0.5; }
    .article-item .source { font-size: 12px; color: #e94560; font-weight: 500; margin-bottom: 4px; }
    .article-item .title { font-size: 14px; font-weight: 500; line-height: 1.4; color: #1a1a2e; }
    .article-item .meta { font-size: 11px; color: #888; margin-top: 6px; }

    /* Now Playing */
    .now-playing {
      background: #fff; border-radius: 16px; padding: 24px; margin-bottom: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    .article-counter { font-size: 12px; color: #e94560; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; font-weight: 600; }
    .article-source { font-size: 14px; color: #666; margin-bottom: 4px; }
    .article-title { font-size: 18px; font-weight: 600; line-height: 1.4; margin-bottom: 16px; color: #1a1a2e; }
    .progress-bar { height: 4px; background: #e9ecef; border-radius: 2px; overflow: hidden; }
    .progress-fill { height: 100%; background: #e94560; width: 0%; transition: width 0.1s linear; }

    /* Controls */
    .controls { display: flex; justify-content: center; gap: 12px; margin: 20px 0; }
    .control-btn {
      width: 52px; height: 52px; border-radius: 50%; border: none;
      background: #fff; color: #1a1a2e; font-size: 18px;
      cursor: pointer; transition: all 0.2s;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .control-btn:hover { transform: scale(1.05); }
    .control-btn:active { transform: scale(0.95); }
    .control-btn.primary { width: 68px; height: 68px; background: #e94560; color: #fff; font-size: 26px; }

    /* Actions */
    .actions { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; margin-bottom: 16px; }
    .action-btn {
      padding: 12px 4px; border-radius: 12px; border: none;
      background: #fff; color: #1a1a2e; font-size: 10px; font-weight: 500;
      cursor: pointer; transition: all 0.2s;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .action-btn:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
    .action-btn .icon { font-size: 20px; }
    .action-btn.delete { color: #dc3545; }
    .action-btn.archive { color: #28a745; }
    .action-btn.later { color: #ffc107; }
    .action-btn.open { color: #007bff; }
    .action-btn.readfull { color: #6f42c1; }

    /* Voice Selector */
    .voice-selector { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; justify-content: center; }
    .voice-option {
      padding: 8px 14px; border-radius: 20px;
      border: 1px solid #dee2e6; background: #fff;
      color: #666; font-size: 12px; cursor: pointer; transition: all 0.2s;
    }
    .voice-option:hover { border-color: #e94560; }
    .voice-option.active { border-color: #e94560; color: #e94560; background: rgba(233,69,96,0.05); }

    /* Voice Button */
    .voice-btn {
      width: 100%; padding: 16px; border-radius: 12px;
      border: 2px dashed #dee2e6; background: #fff;
      color: #666; font-size: 14px; cursor: pointer; transition: all 0.2s;
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .voice-btn:hover { border-color: #adb5bd; }
    .voice-btn.listening { border-color: #e94560; color: #e94560; animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

    /* Help Panel */
    .help-panel {
      background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08); font-size: 12px; color: #666;
    }
    .help-panel h3 { font-size: 13px; color: #1a1a2e; margin-bottom: 8px; }
    .help-panel .commands { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; }
    .help-panel .cmd { display: flex; justify-content: space-between; }
    .help-panel .cmd-key { font-weight: 500; color: #e94560; }

    .sync-btn {
      display: block; width: 100%; padding: 16px; border-radius: 12px; border: none;
      background: #e94560; color: #fff; font-size: 16px; font-weight: 600;
      cursor: pointer; margin-top: 16px;
      box-shadow: 0 2px 8px rgba(233,69,96,0.3);
    }
    .sync-btn:disabled { background: #adb5bd; box-shadow: none; cursor: not-allowed; }

    .empty-state { text-align: center; padding: 60px 20px; color: #666; }
    .empty-state .icon { font-size: 48px; margin-bottom: 16px; }

    .loading { text-align: center; padding: 60px 20px; }
    .spinner {
      width: 40px; height: 40px; border: 3px solid #e9ecef;
      border-top-color: #e94560; border-radius: 50%;
      animation: spin 1s linear infinite; margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .hidden { display: none !important; }

    .toast.show { opacity: 1; }

    /* Full Reader */
    #full-reader {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: #fff; z-index: 1000; padding: 20px;
      display: flex; flex-direction: column;
      padding-top: max(20px, env(safe-area-inset-top));
      padding-bottom: max(20px, env(safe-area-inset-bottom));
    }
    #full-reader-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid #eee;
    }
    #full-reader-content {
      flex: 1; overflow-y: auto; font-size: 18px; line-height: 1.6; color: #333;
      padding-bottom: 500px; /* Space for scrolling */
    }
    .reader-p {
      padding: 12px; border-radius: 8px; margin-bottom: 12px;
      cursor: pointer; transition: all 0.2s; border-left: 3px solid transparent;
    }
    .reader-p:hover { background: #f8f9fa; }
    .reader-p.active {
      background: rgba(233,69,96,0.1);
      border-left-color: #e94560;
      color: #000; font-weight: 500;
    }
    .close-btn {
      padding: 8px 16px; background: #eee; border: none; border-radius: 20px;
      font-weight: 600; cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="container" id="container">
    <header>
      <h1>🎧 Readwise Audio</h1>
      <p class="status" id="status">Ready</p>
    </header>

    <div id="loading" class="loading hidden">
      <div class="spinner"></div>
      <p id="loadingText">Fetching and summarizing articles...</p>
    </div>

    <div id="empty" class="empty-state hidden">
      <div class="icon">📭</div>
      <p>No new articles to play</p>
      <button class="sync-btn" onclick="syncFeed()">Sync Now</button>
    </div>

    <div id="player" class="hidden">
      <!-- Source Toggle -->
      <div class="source-toggle">
        <button class="source-btn active" data-source="all" onclick="setSource('all')">📚 All</button>
        <button class="source-btn" data-source="feed" onclick="setSource('feed')">📥 Feed</button>
        <button class="source-btn" data-source="library" onclick="setSource('library')">📖 Library</button>
      </div>

      <!-- Tabs -->
      <div class="tabs">
        <button class="tab active" onclick="showTab('player-view')">▶️ Player</button>
        <button class="tab" onclick="showTab('list-view')">📋 List (<span id="listCount">0</span>)</button>
        <button class="tab" onclick="showTab('help-view')">❓ Help</button>
      </div>

      <!-- Player View -->
      <div id="player-view">
        <div class="now-playing">
          <div class="article-counter" id="counter">Article 1 of 20</div>
          <div class="article-source" id="source">The Atlantic</div>
          <div class="article-title" id="title">Loading...</div>
          <div class="progress-bar">
            <div class="progress-fill" id="progress"></div>
          </div>
        </div>

        <div class="controls">
          <button class="control-btn" onclick="previousArticle()" title="Previous">⏮️</button>
          <button class="control-btn" onclick="replay()" title="Replay">🔄</button>
          <button class="control-btn primary" id="playPauseBtn" onclick="togglePlayPause()">▶️</button>
          <button class="control-btn" onclick="stop()" title="Stop">⏹️</button>
          <button class="control-btn" onclick="skipArticle()" title="Skip">⏭️</button>
        </div>

        <div class="actions">
          <button class="action-btn archive" onclick="archiveArticle()">
            <span class="icon">📥</span>Archive
          </button>
          <button class="action-btn delete" onclick="deleteArticle()">
            <span class="icon">🗑️</span>Delete
          </button>
          <button class="action-btn later" onclick="laterArticle()">
            <span class="icon">🕐</span>Later
          </button>
          <button class="action-btn readfull" onclick="readFullArticle()">
            <span class="icon">📖</span>Read Full
          </button>
          <button class="action-btn open" onclick="openOriginal()">
            <span class="icon">🌐</span>Original
          </button>
          <button class="action-btn open" onclick="openReader()">
            <span class="icon">📖</span>Reader
          </button>
        </div>

        <div class="voice-selector">
          <button class="voice-option" data-voice="browser" onclick="setVoice('browser')">🔊 Browser</button>
          <button class="voice-option active" data-voice="alloy" onclick="setVoice('alloy')">🎙️ Alloy</button>
          <button class="voice-option" data-voice="echo" onclick="setVoice('echo')">🎙️ Echo</button>
          <button class="voice-option" data-voice="shimmer" onclick="setVoice('shimmer')">🎙️ Shimmer</button>
          <button class="voice-option" data-voice="ash" onclick="setVoice('ash')">🎙️ Ash</button>
          <button class="voice-option" data-voice="ballad" onclick="setVoice('ballad')">🎙️ Ballad</button>
          <button class="voice-option" data-voice="coral" onclick="setVoice('coral')">🎙️ Coral</button>
          <button class="voice-option" data-voice="sage" onclick="setVoice('sage')">🎙️ Sage</button>
          <button class="voice-option" data-voice="verse" onclick="setVoice('verse')">🎙️ Verse</button>
        </div>

        <button class="voice-btn" id="voiceBtn" onmousedown="startListening()" onmouseup="stopListening()" ontouchstart="startListening()" ontouchend="stopListening()">
          <span>🎤</span> Hold to speak command
        </button>
      </div>

      <!-- List View -->
      <div id="list-view" class="hidden">
        <div class="article-list" id="articleList"></div>
      </div>

      <!-- Help View -->
      <div id="help-view" class="hidden">
        <div class="help-panel">
          <h3>🎤 Voice Commands</h3>
          <div class="commands">
            <div class="cmd"><span>"archive"</span><span class="cmd-key">📥</span></div>
            <div class="cmd"><span>"delete"</span><span class="cmd-key">🗑️</span></div>
            <div class="cmd"><span>"later" / "save"</span><span class="cmd-key">🕐</span></div>
            <div class="cmd"><span>"open"</span><span class="cmd-key">🌐</span></div>
            <div class="cmd"><span>"skip" / "next"</span><span class="cmd-key">⏭️</span></div>
            <div class="cmd"><span>"previous"</span><span class="cmd-key">⏮️</span></div>
            <div class="cmd"><span>"replay"</span><span class="cmd-key">🔄</span></div>
            <div class="cmd"><span>"pause" / "stop"</span><span class="cmd-key">⏸️</span></div>
            <div class="cmd"><span>"play"</span><span class="cmd-key">▶️</span></div>
            <div class="cmd"><span>"read full"</span><span class="cmd-key">📖</span></div>
            <div class="cmd"><span>"list"</span><span class="cmd-key">📋</span></div>
          </div>
        </div>
        <div class="help-panel">
          <h3>📚 Sources</h3>
          <p><strong>All:</strong> Everything not archived</p>
          <p><strong>Feed:</strong> New/unread items</p>
          <p><strong>Library:</strong> Saved for later & shortlisted</p>
        </div>
        <div class="help-panel">
          <h3>🎙️ Voices</h3>
          <p><strong>Browser:</strong> Free, works offline</p>
          <p><strong>Nova/Alloy/etc:</strong> Natural OpenAI voices (requires API key)</p>
        </div>
      </div>

      <button class="sync-btn" id="syncBtn" onclick="syncFeed()">Sync Feed</button>
    </div>

    <!-- Full Reader Overlay -->
    <div id="full-reader" class="hidden">
      <div id="full-reader-header">
        <h2 style="font-size: 18px; font-weight: 600;">Reading Article</h2>
        <button class="close-btn" onclick="closeFullReader()">Close</button>
      </div>
      <div id="full-reader-content"></div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    // ============ STATE ============
    let articles = [];
    let currentIndex = 0;
    let isPlaying = false;
    let currentAudio = null;
    let speechSynth = window.speechSynthesis;
    let recognition = null;
    let selectedVoice = localStorage.getItem('voice') || 'alloy';
    let selectedSource = localStorage.getItem('source') || 'all';
    let playedIds = new Set(JSON.parse(localStorage.getItem('played') || '[]'));

    // ============ INIT ============
    document.addEventListener('DOMContentLoaded', () => {
      const cached = localStorage.getItem('articles');
      if (cached) {
        try { articles = JSON.parse(cached); } catch (e) { console.error(e); }
      }

      if (articles.length > 0) {
        showPlayer();
        updateDisplay();
        renderList();
      } else {
        showEmpty();
      }

      // Set active buttons
      document.querySelectorAll('.voice-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.voice === selectedVoice);
      });
      document.querySelectorAll('.source-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.source === selectedSource);
      });

      // Setup speech recognition
      if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'en-US';
        recognition.onresult = (e) => handleVoiceCommand(e.results[0][0].transcript.toLowerCase().trim());
        recognition.onerror = () => document.getElementById('voiceBtn').classList.remove('listening');
        recognition.onend = () => document.getElementById('voiceBtn').classList.remove('listening');
      }
    });

    // ============ SOURCE ============
    function setSource(source) {
      selectedSource = source;
      localStorage.setItem('source', source);
      document.querySelectorAll('.source-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.source === source);
      });
      showToast('Source: ' + source);
      syncFeed();
    }

    // ============ TABS ============
    function showTab(tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');
      ['player-view', 'list-view', 'help-view'].forEach(id => {
        document.getElementById(id).classList.toggle('hidden', id !== tabId);
      });
    }

    // ============ SYNC ============
    async function syncFeed() {
      showLoading();
      updateStatus('Syncing...');

      try {
        const response = await fetch('/api/feed?location=' + selectedSource);
        const data = await response.json();
        if (data.error) throw new Error(data.error);

        articles = data.articles || [];
        localStorage.setItem('articles', JSON.stringify(articles));
        currentIndex = 0;

        if (articles.length === 0) {
          showEmpty();
          updateStatus('No new articles');
        } else {
          showPlayer();
          updateDisplay();
          renderList();
          updateStatus(articles.length + ' articles ready');
          showToast(articles.length + ' articles loaded');
        }
      } catch (error) {
        console.error('Sync error:', error);
        showToast('Sync failed: ' + error.message);
        updateStatus('Sync failed');
        showEmpty();
      }
    }

    // ============ LIST ============
    function renderList() {
      const list = document.getElementById('articleList');
      document.getElementById('listCount').textContent = articles.length;
      list.innerHTML = articles.map((article, i) =>
        '<div class="article-item ' + (i === currentIndex ? 'active' : '') + ' ' + (playedIds.has(article.id) ? 'played' : '') + '" onclick="selectArticle(' + i + ')">' +
        '<div class="source">' + article.source + '</div>' +
        '<div class="title">' + article.title + '</div>' +
        '<div class="meta">' + (article.word_count || '?') + ' words</div>' +
        '</div>'
      ).join('');
    }

    function selectArticle(index) {
      currentIndex = index;
      updateDisplay();
      renderList();
      showTab('player-view');
      document.querySelector('[onclick="showTab(\\'player-view\\')"]').classList.add('active');
      document.querySelector('[onclick="showTab(\\'list-view\\')"]').classList.remove('active');
      document.querySelector('[onclick="showTab(\\'help-view\\')"]').classList.remove('active');
      play();
    }

    // ============ VOICE ============
    function setVoice(voice) {
      selectedVoice = voice;
      localStorage.setItem('voice', voice);
      document.querySelectorAll('.voice-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.voice === voice);
      });
      showToast('Voice: ' + voice);
    }

    // ============ TTS ============
    async function speak(text, onEnd) {
      stop();

      if (selectedVoice === 'browser') {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.0;
        utterance.onend = onEnd;
        utterance.onerror = () => { isPlaying = false; updatePlayButton(); };
        speechSynth.speak(utterance);
        return;
      }

      showToast('Generating audio...');
      try {
        const response = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: selectedVoice }),
        });

        // Check for JSON error response (e.g. invalid API key)
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await response.json();
          if (data.use_browser_tts) throw new Error('Server requested browser TTS');
        }

        if (!response.ok) throw new Error('TTS Network Error');

        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);

        currentAudio = new Audio(audioUrl);
        currentAudio.onended = () => { URL.revokeObjectURL(audioUrl); if (onEnd) onEnd(); };
        currentAudio.onerror = () => { isPlaying = false; updatePlayButton(); };
        currentAudio.play();
      } catch (error) {
        console.error('TTS error:', error);
        showToast('Audio failed, using browser');
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onend = onEnd;
        speechSynth.speak(utterance);
      }
    }

    // ============ PLAYBACK ============
    function togglePlayPause() { isPlaying ? pause() : play(); }

    function play() {
      if (articles.length === 0) return;
      const article = articles[currentIndex];
      const text = 'Next, from ' + article.source + '. ' + article.summary;

      isPlaying = true;
      updatePlayButton();

      let startTime = Date.now();
      const estimatedDuration = text.length * 50;
      const progressInterval = setInterval(() => {
        if (!isPlaying) { clearInterval(progressInterval); return; }
        const progress = Math.min((Date.now() - startTime) / estimatedDuration * 100, 100);
        document.getElementById('progress').style.width = progress + '%';
      }, 100);

      speak(text, () => {
        clearInterval(progressInterval);
        document.getElementById('progress').style.width = '100%';
        markPlayed(article.id);
        setTimeout(() => {
          if (isPlaying && currentIndex < articles.length - 1) {
            currentIndex++;
            updateDisplay();
            renderList();
            play();
          } else if (currentIndex >= articles.length - 1) {
            isPlaying = false;
            updatePlayButton();
            showToast('Finished all articles');
          }
        }, 1000);
      });
    }

    function pause() { stop(); isPlaying = false; updatePlayButton(); }
    function stop() { speechSynth.cancel(); if (currentAudio) { currentAudio.pause(); currentAudio = null; } }
    function replay() { stop(); document.getElementById('progress').style.width = '0%'; play(); }

    function skipArticle() {
      if (currentIndex < articles.length - 1) {
        stop(); markPlayed(articles[currentIndex].id);
        currentIndex++; updateDisplay(); renderList();
        if (isPlaying) play();
      } else showToast('Last article');
    }

    function previousArticle() {
      if (currentIndex > 0) {
        stop(); currentIndex--; updateDisplay(); renderList();
        if (isPlaying) play();
      } else showToast('First article');
    }

    function markPlayed(id) {
      playedIds.add(id);
      localStorage.setItem('played', JSON.stringify([...playedIds].slice(-200)));
      renderList();
    }

    // ============ READ FULL ============
    // ============ READ FULL ============
    let readQueue = [];
    let readIndex = 0;

    function readFullArticle() {
      const article = articles[currentIndex];
      if (!article.content) { showToast('No content, opening Reader...'); openReader(); return; }

      // Stop any current summary playback
      stop();
      isPlaying = false; // logic handled by reader now

      // Parse content into paragraphs
      // Simple parser: remove scripts/styles, split by block tags or double newlines
      const div = document.createElement('div');
      div.innerHTML = article.content;
      
      // Remove unwanted elements
      div.querySelectorAll('script, style, iframe, nav, header, footer').forEach(e => e.remove());
      
      // Get chunks (paragraphs)
      // Strategy: Iterate over <p>, <li>, <blockquote>, <h1>-<h6>
      const blocks = div.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6');
      readQueue = [];
      
      if (blocks.length > 0) {
        blocks.forEach(block => {
          const text = block.innerText.trim();
          if (text.length > 5) readQueue.push(text); // Filter tiny garbage
        });
      } else {
        // Fallback for plain text or weird formatting
        readQueue = div.innerText.split(/\\n\\s*\\n/).map(t => t.trim()).filter(t => t.length > 5);
      }

      // 1. Show UI
      const contentDiv = document.getElementById('full-reader-content');
      contentDiv.innerHTML = readQueue.map((text, i) => 
        \`<div class="reader-p" id="p-\${i}" onclick="playParagraph(\${i})">\${text}</div>\`
      ).join('');
      
      document.getElementById('full-reader').classList.remove('hidden');
      document.getElementById('container').classList.add('hidden'); // Hide main UI

      // 2. Start Reading
      readIndex = 0;
      playParagraph(0);
    }

    function playParagraph(index) {
      if (index >= readQueue.length) {
        showToast('Finished reading');
        return;
      }

      readIndex = index;
      
      // Update UI highlights
      document.querySelectorAll('.reader-p').forEach(p => p.classList.remove('active'));
      const activeP = document.getElementById(\`p-\${index}\`);
      if (activeP) {
        activeP.classList.add('active');
        activeP.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // Stop previous
      stop();

      // Speak current chunk
      isPlaying = true; // reusing global state to keep screen awake/logic consistent
      speak(readQueue[index], () => {
        // On finish, go to next
        playParagraph(index + 1);
      });
    }

    function closeFullReader() {
      stop();
      isPlaying = false;
      document.getElementById('full-reader').classList.add('hidden');
      document.getElementById('container').classList.remove('hidden');
    }

    // ============ ACTIONS ============
    async function archiveArticle() {
      const article = articles[currentIndex];
      showToast('Archiving...');
      try {
        await fetch('/api/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: article.id }) });
        showToast('Archived');
        removeCurrentArticle();
      } catch (e) { showToast('Failed'); }
    }

    async function deleteArticle() {
      const article = articles[currentIndex];
      showToast('Deleting...');
      try {
        await fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: article.id }) });
        showToast('Deleted');
        removeCurrentArticle();
      } catch (e) { showToast('Failed'); }
    }

    async function laterArticle() {
      const article = articles[currentIndex];
      showToast('Saved for later');
      try {
        await fetch('/api/later', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: article.id }) });
        removeCurrentArticle();
      } catch (e) { showToast('Failed'); }
    }

    function removeCurrentArticle() {
      stop();
      articles.splice(currentIndex, 1);
      localStorage.setItem('articles', JSON.stringify(articles));
      if (articles.length === 0) showEmpty();
      else {
        if (currentIndex >= articles.length) currentIndex = articles.length - 1;
        updateDisplay(); renderList(); play();
      }
    }

    function openReader() {
      pause();
      // Try deep link first, then fallback to HTTPS which is a Universal Link
      // readwise://reader/document/{id}
      const deepLink = 'readwise://reader/document/' + articles[currentIndex].id;
      const universalLink = articles[currentIndex].readwise_url;
      
      // On iOS/Mobile, try deep link
      if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
          window.location.href = deepLink;
          // Fallback if app not installed (simple timeout hack)
          setTimeout(() => { window.open(universalLink, '_blank'); }, 500);
      } else {
          window.open(universalLink, '_blank');
      }
    }

    function openOriginal() {
      pause();
      window.open(articles[currentIndex].original_url || articles[currentIndex].url, '_blank');
    }

    // ============ VOICE COMMANDS ============
    function startListening() {
      if (!recognition) { showToast('Voice not supported'); return; }
      pause();
      document.getElementById('voiceBtn').classList.add('listening');
      recognition.start();
    }

    function stopListening() { if (recognition) recognition.stop(); }

    function handleVoiceCommand(cmd) {
      showToast('Heard: ' + cmd);
      if (cmd.includes('archive')) archiveArticle();
      else if (cmd.includes('delete') || cmd.includes('remove')) deleteArticle();
      else if (cmd.includes('later') || cmd.includes('save')) laterArticle();
      else if (cmd.includes('open') || cmd.includes('browser')) openOriginal();
      else if (cmd.includes('reader') || cmd.includes('app')) openReader();
      else if (cmd.includes('skip') || cmd.includes('next')) skipArticle();
      else if (cmd.includes('previous') || cmd.includes('back')) previousArticle();
      else if (cmd.includes('replay') || cmd.includes('again')) replay();
      else if (cmd.includes('pause') || cmd.includes('stop')) pause();
      else if (cmd.includes('play') || cmd.includes('resume')) play();
      else if (cmd.includes('read full') || cmd.includes('full article') || cmd === 'read') readFullArticle();
      else if (cmd.includes('list')) { showTab('list-view'); document.querySelector('[onclick="showTab(\\'list-view\\')"]').click(); }
      else { showToast('Unknown command'); setTimeout(() => play(), 1000); }
    }

    // ============ UI ============
    function updateDisplay() {
      if (articles.length === 0) return;
      const article = articles[currentIndex];
      document.getElementById('counter').textContent = 'Article ' + (currentIndex + 1) + ' of ' + articles.length;
      document.getElementById('source').textContent = article.source;
      document.getElementById('title').textContent = article.title;
      document.getElementById('progress').style.width = '0%';
    }

    function updatePlayButton() { document.getElementById('playPauseBtn').textContent = isPlaying ? '⏸️' : '▶️'; }
    function updateStatus(text) { document.getElementById('status').textContent = text; }

    function showLoading() {
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('player').classList.add('hidden');
      document.getElementById('empty').classList.add('hidden');
    }
    function showPlayer() {
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('player').classList.remove('hidden');
      document.getElementById('empty').classList.add('hidden');
    }
    function showEmpty() {
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('player').classList.add('hidden');
      document.getElementById('empty').classList.remove('hidden');
    }
    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2500);
    }
  </script>
</body>
</html>`;
}
