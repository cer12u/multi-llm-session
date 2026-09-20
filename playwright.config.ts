import { defineConfig,devices } from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',fullyParallel:false,workers:1,timeout:60000,retries:0,
  reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:{command:'node dist/apps/cli/dev.js',url:'http://127.0.0.1:4173/healthz',reuseExistingServer:false,timeout:30000,
    env:{PORT:'4173',PUBLIC_ORIGIN:'http://127.0.0.1:4173',DB_PATH:'data/e2e.sqlite',ADMIN_TOKEN:'e2e-test-operator-only-not-a-production-secret',ALLOW_LIVE_MODELS:'0',QUIET_START:'1'}},
});
