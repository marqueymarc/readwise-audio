import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            READWISE_TOKEN: 'test-readwise-token',
            CLAUDE_API_KEY: 'test-claude-api-key',
          },
          kvNamespaces: ['KV'],
        },
      },
    },
  },
});
