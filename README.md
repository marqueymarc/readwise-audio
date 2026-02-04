# Readwise Audio Summary Player

A PWA that plays AI-generated audio summaries of your Readwise Reader articles with voice commands. It intelligently syncs your Feed (RSS/Newsletters) and Library (Inbox/Later/Shortlist), generates succinct summaries using Claude, and reads them aloud using high-quality OpenAI streaming TTS.

## Features

- **Smart Sync:**
  - **Feed Tab:** Shows RSS and Newsletter items (`location: feed`).
  - **Library Tab:** Shows Inbox (`new`), Later (`later`), and Shortlist (`shortlist`) items.
  - **Recent First:** Articles are strictly ordered by date.
- **AI Summaries:** Generates ~30-second summaries using Claude 3 Haiku.
- **High-Quality Audio:** Streaming Text-to-Speech using OpenAI's `gpt-4o-mini-tts` (low latency).
- **Mobile Optimized:**
  - **Deep Linking:** "Reader" button launches the native **Readwise Reader** iOS app (`wiseread://`).
  - **Web Fallback:** Falls back to `read.readwise.io` for reliable web access.
  - **PWA:** Installable as a full-screen app on iOS/Android.
- **Voice Commands:** "archive", "delete", "later", "open", "skip", "pause", "read full".
- **Robust:** Handles API rate limits (429 errors) with smart retries.

---

## Deployment Steps

### 1. Install Wrangler CLI
```bash
npm install -g wrangler
```

### 2. Login to Cloudflare
```bash
wrangler login
```

### 3. Create KV Namespace
```bash
wrangler kv namespace create "KV"
```
Copy the ID output and paste it into `wrangler.toml` replacing `YOUR_KV_NAMESPACE_ID`.

### 4. Set Up API Keys

#### Anthropic (Summaries)
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API Key.
3. Ensure you have credits loaded.

#### OpenAI (TTS)
1. Go to [platform.openai.com](https://platform.openai.com)
2. Create an API Key.

#### Readwise (Content)
1. Go to Reader → Preferences → Access tokens.
2. Copy your **Reader** token.

### 5. Add Secrets
Run these commands:

```bash
wrangler secret put READWISE_TOKEN
# Paste Readwise token
```

```bash
wrangler secret put CLAUDE_API_KEY
# Paste Anthropic key
```

```bash
wrangler secret put OPENAI_API_KEY
# Paste OpenAI key
```

### 6. Deploy
```bash
wrangler deploy
```
This outputs your worker URL.

---

## Usage

### On iPhone (PWA)
1. Open the URL in Safari.
2. Tap Share → **"Add to Home Screen"**.
3. Open the app from your home screen.

### Controls
- **Tabs:** Switch between **Feed** (RSS) and **Library** (Inbox/Later).
- **Voice Dropdown:** Select from OpenAI voices (Alloy, Echo, Shimmer, etc.) or free Browser TTS.
- **Actions:**
  - **Reader:** Opens the article in the native Readwise Reader app.
  - **Original:** Opens the source URL.
  - **Read Full:** Reads the full article content aloud.
  - **Archive/Delete/Later:** Managing article state in Readwise.

### Voice Commands
Hold the mic button and say:
- "archive" / "delete" / "later"
- "open" (original) / "reader" (app)
- "skip" / "next" / "previous"
- "pause" / "resume" / "stop"
- "read full"

---

## Configuration

### Customization
Edit `worker.js` constants:
- `SUMMARY_WORD_TARGET`: Target length of summaries (default: 120 words).
- `CLAUDE_MODEL`: AI model for summarization (default: `claude-3-haiku-20240307`).

### TTS Voices
The app supports:
- **OpenAI:** `alloy`, `echo`, `shimmer`, `ash`, `ballad`, `coral`, `sage`, `verse`.
- **Browser:** Local device voice (free, offline).

---

## Troubleshooting

### "Sync failed" / "Empty Feed"
- Check that your `READWISE_TOKEN` is valid.
- Ensure you have unarchived items in your Feed/Inbox.
- Verify `wrangler tail` logs for 429 errors (the app automatically retries, but heavy rate limits might persist).

### Deep Link doesn't open App
- Ensure you have **Readwise Reader** (yellow icon) installed.
- The app uses `wiseread://`. If that fails, it falls back to the web reader.

---

## Costs (Estimated)
| Service | Cost |
|---------|------|
| **Cloudflare** | Free (100k requests/day) |
| **Claude** | ~$0.50 for 600 summaries |
| **OpenAI TTS** | ~$9.00 per 1M characters (very cheap for summaries) |
| **Total** | **<$2.00/month** for heavy daily use |

---

## Local Development

You can run the full Cloudflare worker locally to debug logic (and see `console.log` output).

1.  **Create a `.dev.vars` file** in the project root:
    ```ini
    READWISE_TOKEN=your_token
    CLAUDE_API_KEY=your_key
    OPENAI_API_KEY=your_key
    ```
2.  **Start the Local Server:**
    ```bash
    npx wrangler dev
    ```
3.  **Open:** `http://localhost:8787`

**Benefits:**
-   **Real-time Logs:** See console output in your terminal.
-   **Safe Testing:** Uses a local KV store by default, preserving your production data.

---

## Testing
Run the comprehensive test suite:
```bash
npm install
npm test
```
