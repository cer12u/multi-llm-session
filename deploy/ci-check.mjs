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
const location = lines.find(line => /error TS\d+/.test(line))
  ?? lines.find(line => /^FAIL\s+tests\//.test(line))
  ?? lines.find(line => /R2-STATE-\d+/.test(line) && /[×✕❯]|failed/i.test(line))
  ?? lines.find(line => /(?:AssertionError|Error|TypeError|ZodError):/.test(line))
  ?? (result.error?.code || result.signal || 'See run logs');
const reason = lines.find(line => /^(AssertionError|Error|TypeError|ZodError):/.test(line));
const clean = value => value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 220);
const diagnostic = clean(status === 0 ? '' : `${stage}: ${location}${reason && reason !== location ? ' | ' + reason : ''}`);
const counts = clean(lines.filter(line => /^(Test Files|Tests)\s+/.test(line)).join('; '));
mkdirSync('artifacts', { recursive: true });
writeFileSync(`artifacts/${stage}-summary.json`, JSON.stringify({ stage, exitCode: status, diagnostic, counts, sha: process.env.GITHUB_SHA ?? 'local', mode: 'synthetic' }, null, 2));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `diagnostic=${diagnostic}\ncounts=${counts}\n`);
process.exitCode = status;
