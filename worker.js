/**
 * Readwise Audio Summary Worker
 *
 * Cloudflare Worker that:
 * 1. Fetches articles from Readwise Reader
 * 2. Summarizes them with Claude
 * 3. Serves a PWA for audio playback
 * 4. Handles archive/delete/later actions
 */

// ============ CONFIGURATION (exported for testing) ============

export const CLAUDE_MODEL = 'claude-3-haiku-20240307';
export const SUMMARY_WORD_TARGET = 120; // ~30 seconds at normal speech

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

    // CORS headers for PWA
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route requests
      if (path === '/' || path === '/index.html') {
        return serveHTML(env);
      }
      if (path === '/api/feed') {
        return handleFeed(request, env, corsHeaders);
      }
      if (path === '/api/archive' && request.method === 'POST') {
        return handleArchive(request, env, corsHeaders);
      }
      if (path === '/api/delete' && request.method === 'POST') {
        return handleDelete(request, env, corsHeaders);
      }
      if (path === '/api/later' && request.method === 'POST') {
        return handleLater(request, env, corsHeaders);
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
  // 1. Fetch articles from Readwise Reader
  const articles = await fetchReadwiseArticles(env);

  // 2. Get heard articles from KV
  const heardIds = await getHeardIds(env);
  const laterIds = await getLaterIds(env);

  // 3. Filter: include if not heard, OR if in later list
  const newArticles = articles.filter(article => {
    const isHeard = heardIds.has(article.id);
    const isLater = laterIds.has(article.id);
    return !isHeard || isLater;
  });

  // 4. Summarize each article with Claude
  const summaries = [];
  for (const article of newArticles.slice(0, 30)) { // Limit to 30 per sync
    try {
      const summary = await summarizeArticle(article, env);
      summaries.push({
        id: article.id,
        title: article.title || 'Untitled',
        source: extractSource(article),
        summary: summary,
        url: article.url,
        readwise_url: article.source_url || `https://readwise.io/reader/document/${article.id}`,
      });

      // Remove from later list if it was there
      if (laterIds.has(article.id)) {
        await env.KV.delete(`later:${article.id}`);
      }
    } catch (error) {
      console.error(`Failed to summarize article ${article.id}:`, error);
    }
  }

  return new Response(JSON.stringify({ articles: summaries }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleArchive(request, env, corsHeaders) {
  const { id } = await request.json();

  // Mark as heard
  await env.KV.put(`heard:${id}`, Date.now().toString(), { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days

  // Archive in Readwise
  await updateReadwiseDocument(id, { location: 'archive' }, env);

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleDelete(request, env, corsHeaders) {
  const { id } = await request.json();

  // Mark as heard
  await env.KV.put(`heard:${id}`, Date.now().toString(), { expirationTtl: 60 * 60 * 24 * 30 });

  // Delete from Readwise
  await deleteReadwiseDocument(id, env);

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleLater(request, env, corsHeaders) {
  const { id } = await request.json();

  // Add to later list (will reappear next sync)
  await env.KV.put(`later:${id}`, Date.now().toString(), { expirationTtl: 60 * 60 * 24 * 7 }); // 7 days

  // Remove from heard if it was there
  await env.KV.delete(`heard:${id}`);

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ============ READWISE API ============

async function fetchReadwiseArticles(env) {
  const response = await fetch('https://readwise.io/api/v3/list/', {
    headers: {
      'Authorization': `Token ${env.READWISE_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Readwise API error: ${response.status}`);
  }

  const data = await response.json();

  // Filter to only feed/new/later items (not archived)
  return (data.results || []).filter(doc =>
    doc.location !== 'archive' && doc.category === 'article'
  );
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

  if (!response.ok) {
    throw new Error(`Readwise update error: ${response.status}`);
  }

  return response.json();
}

async function deleteReadwiseDocument(id, env) {
  const response = await fetch(`https://readwise.io/api/v3/delete/${id}/`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Token ${env.READWISE_TOKEN}`,
    },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Readwise delete error: ${response.status}`);
  }

  return true;
}

// ============ CLAUDE API ============

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

// ============ HELPERS (exported for testing) ============

export function extractSource(article) {
  if (article.site_name) return article.site_name;
  if (article.source_url) {
    try {
      const url = new URL(article.source_url);
      return url.hostname.replace('www.', '');
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
  const manifest = {
    name: 'Readwise Audio',
    short_name: 'RW Audio',
    start_url: '/',
    display: 'standalone',
    background_color: '#1a1a2e',
    theme_color: '#e94560',
    icons: [
      {
        src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23e94560" width="100" height="100" rx="20"/><text x="50" y="65" text-anchor="middle" font-size="50" fill="white">🎧</text></svg>',
        sizes: '192x192',
        type: 'image/svg+xml',
      },
    ],
  };

  return new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function serveHTML(env) {
  // The HTML is stored in KV for easy updates, or we inline it
  const html = getHTMLContent();
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}

function getHTMLContent() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#1a1a2e">
  <title>Readwise Audio</title>
  <link rel="manifest" href="/manifest.json">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #eee;
      min-height: 100vh;
      padding: 20px;
      padding-top: env(safe-area-inset-top, 20px);
      padding-bottom: env(safe-area-inset-bottom, 20px);
    }

    .container {
      max-width: 500px;
      margin: 0 auto;
    }

    header {
      text-align: center;
      margin-bottom: 30px;
    }

    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 5px;
    }

    .status {
      font-size: 14px;
      color: #888;
    }

    .now-playing {
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
    }

    .article-counter {
      font-size: 12px;
      color: #e94560;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }

    .article-source {
      font-size: 14px;
      color: #888;
      margin-bottom: 4px;
    }

    .article-title {
      font-size: 18px;
      font-weight: 600;
      line-height: 1.4;
      margin-bottom: 16px;
    }

    .progress-bar {
      height: 4px;
      background: rgba(255,255,255,0.1);
      border-radius: 2px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: #e94560;
      width: 0%;
      transition: width 0.1s linear;
    }

    .controls {
      display: flex;
      justify-content: center;
      gap: 16px;
      margin: 24px 0;
    }

    .control-btn {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      border: none;
      background: rgba(255,255,255,0.1);
      color: #fff;
      font-size: 24px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .control-btn:hover { background: rgba(255,255,255,0.2); }
    .control-btn:active { transform: scale(0.95); }

    .control-btn.primary {
      width: 80px;
      height: 80px;
      background: #e94560;
      font-size: 32px;
    }

    .control-btn.primary:hover { background: #ff6b6b; }

    .actions {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }

    .action-btn {
      padding: 16px 8px;
      border-radius: 12px;
      border: none;
      background: rgba(255,255,255,0.05);
      color: #fff;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }

    .action-btn:hover { background: rgba(255,255,255,0.1); }
    .action-btn:active { transform: scale(0.95); }

    .action-btn .icon { font-size: 24px; }

    .action-btn.delete { color: #ff6b6b; }
    .action-btn.archive { color: #4ecca3; }
    .action-btn.later { color: #ffd93d; }
    .action-btn.open { color: #6c9bcf; }

    .voice-btn {
      width: 100%;
      padding: 20px;
      border-radius: 16px;
      border: 2px dashed rgba(255,255,255,0.2);
      background: transparent;
      color: #888;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    .voice-btn:hover { border-color: rgba(255,255,255,0.4); color: #fff; }
    .voice-btn.listening {
      border-color: #e94560;
      color: #e94560;
      animation: pulse 1s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    .sync-btn {
      display: block;
      width: 100%;
      padding: 16px;
      border-radius: 12px;
      border: none;
      background: #e94560;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 20px;
    }

    .sync-btn:disabled {
      background: #444;
      cursor: not-allowed;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #666;
    }

    .empty-state .icon { font-size: 48px; margin-bottom: 16px; }

    .loading {
      text-align: center;
      padding: 60px 20px;
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #e94560;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .hidden { display: none !important; }

    .toast {
      position: fixed;
      bottom: 100px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.8);
      color: #fff;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    }

    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🎧 Readwise Audio</h1>
      <p class="status" id="status">Ready</p>
    </header>

    <div id="loading" class="loading hidden">
      <div class="spinner"></div>
      <p>Fetching and summarizing articles...</p>
    </div>

    <div id="empty" class="empty-state hidden">
      <div class="icon">📭</div>
      <p>No new articles to play</p>
      <button class="sync-btn" onclick="syncFeed()">Sync Now</button>
    </div>

    <div id="player" class="hidden">
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
        <button class="control-btn" onclick="skipArticle()" title="Skip">⏭️</button>
      </div>

      <div class="actions">
        <button class="action-btn archive" onclick="archiveArticle()">
          <span class="icon">📥</span>
          Archive
        </button>
        <button class="action-btn delete" onclick="deleteArticle()">
          <span class="icon">🗑️</span>
          Delete
        </button>
        <button class="action-btn later" onclick="laterArticle()">
          <span class="icon">🕐</span>
          Later
        </button>
        <button class="action-btn open" onclick="openArticle()">
          <span class="icon">🌐</span>
          Open
        </button>
      </div>

      <button class="voice-btn" id="voiceBtn" onmousedown="startListening()" onmouseup="stopListening()" ontouchstart="startListening()" ontouchend="stopListening()">
        <span>🎤</span> Hold to speak command
      </button>
    </div>

    <button class="sync-btn" id="syncBtn" onclick="syncFeed()">Sync Feed</button>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    // ============ STATE ============
    let articles = [];
    let currentIndex = 0;
    let isPlaying = false;
    let speechSynth = window.speechSynthesis;
    let currentUtterance = null;
    let recognition = null;

    // ============ INIT ============
    document.addEventListener('DOMContentLoaded', () => {
      // Load cached articles if any
      const cached = localStorage.getItem('articles');
      if (cached) {
        articles = JSON.parse(cached);
        if (articles.length > 0) {
          showPlayer();
          updateDisplay();
        }
      }

      // Setup speech recognition
      if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'en-US';

        recognition.onresult = (event) => {
          const command = event.results[0][0].transcript.toLowerCase().trim();
          handleVoiceCommand(command);
        };

        recognition.onerror = (event) => {
          console.error('Speech recognition error:', event.error);
          document.getElementById('voiceBtn').classList.remove('listening');
        };

        recognition.onend = () => {
          document.getElementById('voiceBtn').classList.remove('listening');
        };
      }
    });

    // ============ SYNC ============
    async function syncFeed() {
      showLoading();
      updateStatus('Syncing...');

      try {
        const response = await fetch('/api/feed');
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
          updateStatus(\`\${articles.length} articles ready\`);
          showToast(\`\${articles.length} articles loaded\`);
        }
      } catch (error) {
        console.error('Sync error:', error);
        showToast('Sync failed: ' + error.message);
        updateStatus('Sync failed');
        showEmpty();
      }
    }

    // ============ PLAYBACK ============
    function togglePlayPause() {
      if (isPlaying) {
        pause();
      } else {
        play();
      }
    }

    function play() {
      if (articles.length === 0) return;

      const article = articles[currentIndex];
      const text = \`Next, from \${article.source}. \${article.summary}\`;

      // Cancel any ongoing speech
      speechSynth.cancel();

      currentUtterance = new SpeechSynthesisUtterance(text);
      currentUtterance.rate = 1.0;
      currentUtterance.pitch = 1.0;

      // Progress tracking
      let startTime = Date.now();
      const estimatedDuration = text.length * 60; // rough estimate in ms

      const progressInterval = setInterval(() => {
        if (!isPlaying) {
          clearInterval(progressInterval);
          return;
        }
        const elapsed = Date.now() - startTime;
        const progress = Math.min((elapsed / estimatedDuration) * 100, 100);
        document.getElementById('progress').style.width = progress + '%';
      }, 100);

      currentUtterance.onend = () => {
        clearInterval(progressInterval);
        document.getElementById('progress').style.width = '100%';

        // Auto-advance after a brief pause
        setTimeout(() => {
          if (isPlaying && currentIndex < articles.length - 1) {
            markHeard(articles[currentIndex].id);
            currentIndex++;
            updateDisplay();
            play();
          } else if (currentIndex >= articles.length - 1) {
            markHeard(articles[currentIndex].id);
            isPlaying = false;
            updatePlayButton();
            showToast('Finished all articles');
          }
        }, 1500);
      };

      currentUtterance.onerror = (event) => {
        console.error('Speech error:', event);
        clearInterval(progressInterval);
        isPlaying = false;
        updatePlayButton();
      };

      speechSynth.speak(currentUtterance);
      isPlaying = true;
      updatePlayButton();
    }

    function pause() {
      speechSynth.cancel();
      isPlaying = false;
      updatePlayButton();
    }

    function replay() {
      pause();
      document.getElementById('progress').style.width = '0%';
      play();
    }

    function skipArticle() {
      if (currentIndex < articles.length - 1) {
        pause();
        markHeard(articles[currentIndex].id);
        currentIndex++;
        updateDisplay();
        play();
      } else {
        showToast('Last article');
      }
    }

    function previousArticle() {
      if (currentIndex > 0) {
        pause();
        currentIndex--;
        updateDisplay();
        play();
      } else {
        showToast('First article');
      }
    }

    function markHeard(id) {
      // Just for local tracking; server tracks separately
      const heard = JSON.parse(localStorage.getItem('heard') || '[]');
      if (!heard.includes(id)) {
        heard.push(id);
        localStorage.setItem('heard', JSON.stringify(heard.slice(-200)));
      }
    }

    // ============ ACTIONS ============
    async function archiveArticle() {
      const article = articles[currentIndex];
      showToast('Archiving...');

      try {
        await fetch('/api/archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: article.id }),
        });
        showToast('Archived');
        skipArticle();
      } catch (error) {
        showToast('Failed to archive');
      }
    }

    async function deleteArticle() {
      const article = articles[currentIndex];
      showToast('Deleting...');

      try {
        await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: article.id }),
        });
        showToast('Deleted');
        skipArticle();
      } catch (error) {
        showToast('Failed to delete');
      }
    }

    async function laterArticle() {
      const article = articles[currentIndex];
      showToast('Saved for later');

      try {
        await fetch('/api/later', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: article.id }),
        });
        skipArticle();
      } catch (error) {
        showToast('Failed to save');
      }
    }

    function openArticle() {
      const article = articles[currentIndex];
      pause();
      window.open(article.readwise_url || article.url, '_blank');
    }

    // ============ VOICE COMMANDS ============
    function startListening() {
      if (!recognition) {
        showToast('Voice not supported');
        return;
      }

      pause(); // Pause playback while listening
      document.getElementById('voiceBtn').classList.add('listening');
      recognition.start();
    }

    function stopListening() {
      if (recognition) {
        recognition.stop();
      }
    }

    function handleVoiceCommand(command) {
      console.log('Voice command:', command);
      showToast('Heard: ' + command);

      if (command.includes('archive')) {
        archiveArticle();
      } else if (command.includes('delete') || command.includes('remove')) {
        deleteArticle();
      } else if (command.includes('later') || command.includes('save')) {
        laterArticle();
      } else if (command.includes('open') || command.includes('browser')) {
        openArticle();
      } else if (command.includes('skip') || command.includes('next')) {
        skipArticle();
      } else if (command.includes('previous') || command.includes('back')) {
        previousArticle();
      } else if (command.includes('replay') || command.includes('again')) {
        replay();
      } else if (command.includes('pause') || command.includes('stop')) {
        pause();
      } else if (command.includes('play') || command.includes('resume')) {
        play();
      } else {
        showToast('Unknown command');
        // Resume playback after unknown command
        setTimeout(() => play(), 1000);
      }
    }

    // ============ UI HELPERS ============
    function updateDisplay() {
      if (articles.length === 0) return;

      const article = articles[currentIndex];
      document.getElementById('counter').textContent = \`Article \${currentIndex + 1} of \${articles.length}\`;
      document.getElementById('source').textContent = article.source;
      document.getElementById('title').textContent = article.title;
      document.getElementById('progress').style.width = '0%';
    }

    function updatePlayButton() {
      document.getElementById('playPauseBtn').textContent = isPlaying ? '⏸️' : '▶️';
    }

    function updateStatus(text) {
      document.getElementById('status').textContent = text;
    }

    function showLoading() {
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('player').classList.add('hidden');
      document.getElementById('empty').classList.add('hidden');
      document.getElementById('syncBtn').classList.add('hidden');
    }

    function showPlayer() {
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('player').classList.remove('hidden');
      document.getElementById('empty').classList.add('hidden');
      document.getElementById('syncBtn').classList.remove('hidden');
    }

    function showEmpty() {
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('player').classList.add('hidden');
      document.getElementById('empty').classList.remove('hidden');
      document.getElementById('syncBtn').classList.add('hidden');
    }

    function showToast(message) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
  </script>
</body>
</html>`;
}
