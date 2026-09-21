/** Read-only CI diagnostics. Preserve command status; only synthetic CI runs use this wrapper. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const stage = process.argv[2];
if (!['typecheck', 'tests'].includes(stage)) throw new Error('Expected typecheck or tests');
const args = stage === 'typecheck' ? ['run', 'typecheck'] : ['test'];
const result = spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
const status = result.status ?? 1;
const text = ((result.stdout ?? '') + '\n' + (result.stderr ?? '')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const lines = text.split(/\r?\n/).map(line => line.trim());
const clean = (value, limit = 220) => value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, limit);
const failures = [];
for (let i = 0; i < lines.length; i++) {
  if (/error TS\d+/.test(lines[i])) failures.push(clean(lines[i], 190));
  if (!/^FAIL\s+tests\//.test(lines[i])) continue;
  const end = lines.findIndex((line, n) => n > i && /^FAIL\s+tests\//.test(line));
  const block = lines.slice(i + 1, end < 0 ? lines.length : end);
  const location = block.find(line => /^❯\s+tests\/[^ ]+:\d+/.test(line))?.replace(/^❯\s+/, '')
    ?? lines[i].match(/^FAIL\s+(tests\/[^ ]+)/)?.[1] ?? 'tests';
  const reason = block.find(line => /^(AssertionError|Error|TypeError|ZodError|SqliteError):/.test(line)) ?? 'See full test log';
  failures.push(clean(`${location}: ${reason}`, 190));
}
const fallback = lines.find(line => /(?:AssertionError|Error|TypeError|ZodError):/.test(line))
  ?? (result.error?.code || result.signal || 'See run logs');
const diagnostic = clean(status === 0 ? '' : `${stage}: ${failures[0] ?? fallback}`);
const counts = clean(lines.filter(line => /^(Test Files|Tests)\s+/.test(line)).join('; '));
const details = failures.length ? [...new Set(failures)].slice(0, 10) : [status === 0 ? counts || `${stage} passed` : diagnostic];
mkdirSync('artifacts', { recursive: true });
writeFileSync(`artifacts/${stage}-summary.json`, JSON.stringify({ stage, exitCode: status, diagnostic, counts, failures: details, sha: process.env.GITHUB_SHA ?? 'local', mode: 'synthetic' }, null, 2));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `diagnostic=${diagnostic}\ncounts=${counts}\nfailures=${JSON.stringify(details)}\n`);
process.exitCode = status;
