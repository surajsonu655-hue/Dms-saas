import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000,
    env: { NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://dms:dms@localhost:5432/dms_test', STORAGE_DIR: '/tmp/dms-test-storage', JWT_SECRET: 'test-secret', JWT_REFRESH_SECRET: 'test-refresh', TOKEN_ENC_KEY: 'test-enc-key' },
  },
});
