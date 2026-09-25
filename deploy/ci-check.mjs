/** Read-only diagnostics for synthetic CI. Every command keeps its original exit status. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const stage = process.argv[2];
const commands = {
  install: ['npm', ['ci']], typecheck: ['npm', ['run', 'typecheck']], tests: ['npm', ['test']],
  build: ['npm', ['run', 'build']], schemas: ['node', ['dist/apps/cli/schema.js', '--check']],
  lab: ['npm', ['run', 'lab']], browser: ['npx', ['playwright', 'install', '--with-deps', 'chromium']],
  e2e: ['npm', ['run', 'test:e2e']],
};
if (!Object.hasOwn(commands, stage)) throw new Error('Unknown verification stage');
const [command, args] = commands[stage];
const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
const status = result.status ?? 1;
const text = ((result.stdout ?? '') + '\n' + (result.stderr ?? '')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const lines = text.split(/\r?\n/).map(line => line.trim());
const clean = (value, limit = 220) => value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, limit);
const failures = [];
for (let i = 0; i < lines.length; i++) {
  if (/error TS\d+/.test(lines[i])) failures.push(clean(lines[i], 200));
  const unit = /^FAIL\s+tests\//.test(lines[i]);
  const browser = /^\d+\)\s+\[.+?\].*tests\//.test(lines[i]);
  if (!unit && !browser) continue;
  const end = lines.findIndex((line, n) => n > i && (/^FAIL\s+tests\//.test(line) || /^\d+\)\s+\[.+?\].*tests\//.test(line)));
  const block = lines.slice(i + 1, end < 0 ? lines.length : end);
  const location = block.find(line => /^❯\s+tests\/[^ ]+:\d+/.test(line))?.replace(/^❯\s+/, '')
    ?? block.map(line => line.match(/at .*?(tests\/[^ :()]+:\d+:\d+)/)?.[1]).find(Boolean)
    ?? lines[i].match(/(tests\/[^ :]+(?::\d+:\d+)?)/)?.[1] ?? stage;
  const reason = block.find(line => /(?:AssertionError|Error|TypeError|ZodError|SqliteError):/.test(line))
    ?? block.find(line => /(?:timed out|timeout|failed)/i.test(line)) ?? 'See full stage log';
  const values = block.filter(line => /^(Expected|Received)(?: substring| string| pattern)?\s*:/.test(line)).slice(0, 2).map(line => clean(line, 62));
  const waiting = block.find(line => /waiting for (?:getBy|locator|expect)/.test(line));
  const detail = values.length ? values.join(' | ') : waiting ?? '';
  failures.push(clean(`${location}: ${clean(reason, 75)}${detail ? ' | ' + detail : ''}`, 220));
}
const fallback = lines.find(line => /(?:AssertionError|Error|TypeError|ZodError):/.test(line))
  ?? (result.error?.code || result.signal || 'See run logs');
const diagnostic = clean(status === 0 ? '' : `${stage}: ${failures[0] ?? fallback}`);
const counts = clean(lines.filter(line => /^(Test Files|Tests)\s+/.test(line) || /^\d+ (?:passed|failed|skipped)/.test(line)).join('; '));
const details = status === 0 ? [] : failures.length ? [...new Set(failures)].slice(0, 10) : [diagnostic];
mkdirSync('artifacts', { recursive: true });
writeFileSync(`artifacts/${stage}.log`, text);
writeFileSync(`artifacts/${stage}-summary.json`, JSON.stringify({ stage, exitCode: status, diagnostic, counts, failures: details, sha: process.env.GITHUB_SHA ?? 'local', mode: 'synthetic' }, null, 2));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
  `diagnostic=${diagnostic}\ncounts=${counts}\nfailures=${status === 0 ? '' : JSON.stringify(details)}\ncountsJson=${JSON.stringify([counts || `${stage} passed`])}\n`);
process.exitCode = status;
