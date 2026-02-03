# Readwise Audio Summary Player

A PWA that plays AI-generated audio summaries of your Readwise Reader articles with voice commands.

## Features

- Fetches articles from Readwise Reader
- Generates 30-second summaries using Claude
- Plays summaries using browser text-to-speech
- Voice commands: "archive", "delete", "later", "open", "skip", "pause"
- Button controls as fallback
- Installable as PWA on iPhone

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

This opens a browser to authenticate.

### 3. Create KV Namespace

```bash
wrangler kv namespace create "KV"
```

This outputs something like:
```
{ binding = "KV", id = "abc123..." }
```

**Copy that ID** and paste it into `wrangler.toml` replacing `YOUR_KV_NAMESPACE_ID`.

### 4. Set Up Claude API Access

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Go to **Settings** → **API Keys**
4. Click **Create Key**, copy it
5. Go to **Settings** → **Billing** → Add $5 credit (your usage will be ~$0.50/month)

### 5. Add Secrets

Run these commands (you'll be prompted to paste each value):

```bash
wrangler secret put READWISE_TOKEN
```
Paste your Readwise Reader token (from Reader → Preferences → Access tokens)

```bash
wrangler secret put CLAUDE_API_KEY
```
Paste your Anthropic API key from step 4.

### 6. Deploy

```bash
wrangler deploy
```

This outputs your URL:
```
Published readwise-audio to https://readwise-audio.YOUR-SUBDOMAIN.workers.dev
```

---

## Using the App

### On iPhone:

1. Open the URL in Safari
2. Tap the Share button (box with arrow)
3. Scroll down, tap **"Add to Home Screen"**
4. Tap **Add**

Now you have an app icon that opens full-screen!

### Daily Use:

1. Open the app
2. Tap **Sync Feed** to fetch new articles
3. Tap **▶️** to start listening
4. Between articles, use buttons OR hold the mic button and say:
   - "archive" - saves and moves to next
   - "delete" - removes from Readwise
   - "later" - will appear again tomorrow
   - "open" - opens in browser/Reader
   - "skip" / "next" - move to next article
   - "pause" - stops playback

---

## Customization

### Change summary length

Edit `SUMMARY_WORD_TARGET` in `worker.js` (line 12).

### Change Claude model

Edit `CLAUDE_MODEL` in `worker.js`. Options:
- `claude-3-haiku-20240307` (fastest, cheapest - recommended)
- `claude-3-5-sonnet-20241022` (better quality, higher cost)

### Change TTS voice/speed

In the HTML section, find `currentUtterance.rate = 1.0` and adjust:
- `rate`: 0.5 (slow) to 2.0 (fast)
- `pitch`: 0.5 (low) to 2.0 (high)

---

## Troubleshooting

### "Sync failed"
- Check your READWISE_TOKEN is correct (Reader → Preferences → Access tokens)
- Make sure it's a Reader token, not classic Readwise

### No audio playing
- iOS Safari requires a user tap to enable audio - tap play button first
- Check your phone isn't on silent mode

### Voice commands not working
- Must hold the mic button while speaking
- Speak clearly after the button shows "listening" state
- Some browsers require HTTPS (Cloudflare Workers provides this)

### Articles not showing
- Check you have articles in Readwise Reader (not archived)
- The app only shows articles with `category: "article"`

---

## Costs

| Service | Monthly Cost |
|---------|--------------|
| Cloudflare Workers | Free (100k requests/day) |
| Cloudflare KV | Free (100k reads/day) |
| Claude Haiku | ~$0.50 for 600 articles |
| Browser TTS | Free |
| **Total** | **~$0.50/month** |

---

## Testing

The project includes a comprehensive test suite using Vitest with Cloudflare's worker pool.

### Install Dependencies

```bash
npm install
```

### Run Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

### Test Coverage

The test suite covers:

| Category | Tests |
|----------|-------|
| **Unit: extractSource** | 8 tests - source extraction from various article formats |
| **Unit: getHeardIds/getLaterIds** | 5 tests - KV list parsing |
| **Unit: Configuration** | 2 tests - config constants |
| **Integration: API Endpoints** | 10 tests - all 4 endpoints + CORS + 404 |
| **Error Handling** | 2 tests - Readwise/Claude API failures |
| **Edge Cases** | 2 tests - empty feeds, missing fields |

### Adding Tests

Tests are in `worker.test.js`. The test file:
- Mocks KV store with `createMockKV()`
- Mocks external APIs (Readwise, Claude) by overriding `globalThis.fetch`
- Uses realistic fixtures matching Readwise API response format

---

## Updating

After making changes to `worker.js`:

```bash
wrangler deploy
```

Changes are live in seconds.
