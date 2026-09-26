// Connectivity smoke tests only. These do not implement or validate LLM conversation behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The application plan uses Node.js 24; CI explicitly installs that major version.
test('runner provides Node.js 24', () => {
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
});

// Reading a committed file also verifies that Actions checked out this repository.
test('checkout includes the dedicated-session project README', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /^# multi-llm-session\s*$/m);
  assert.match(readme, /専用Webアプリ/);
});
