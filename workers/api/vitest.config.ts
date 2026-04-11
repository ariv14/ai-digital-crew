import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Enable compatibility flags here if needed during tests
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
  },
});
