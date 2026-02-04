
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
