// Fix mode: apply the smallest Cargo.lock upgrades that clear security advisories and yanked versions,
// run the project's tests, and open (or refresh) one pull request a human approves.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseVersion } from './semver.js';
import { parseLock } from './parse.js';

export const FIX_MARKER = '<!-- tensorust-cargo-check:fix -->';
export const BRANCH = 'tensorust/dependency-fixes';

// Cargo's caret rule: an upgrade stays inside the requirement when the left-most non-zero part is unchanged.
export function compatible(from, to) {
  const a = parseVersion(from), b = parseVersion(to);
  if (!a || !b) return false;
  if (a.M !== b.M) return false;
  if (a.M > 0) return true;
  if ((a.m || 0) !== (b.m || 0)) return false;
  if ((a.m || 0) > 0) return true;
  return (a.p || 0) === (b.p || 0);
}

// What to change: one plan item per locked package, from the check result.
export function planFixes(r) {
  const plan = [], manual = [];
  const seen = new Set();
  for (const { row, a } of r.security) {
    const key = row.name + '@' + row.version;
    if (seen.has(key)) continue;
    if (a.upgrade && compatible(row.version, a.upgrade)) { seen.add(key); plan.push({ name: row.name, from: row.version, to: a.upgrade, precise: true, why: a.rs + (a.summary ? ': ' + a.summary : '') }); }
    else manual.push({ name: row.name, from: row.version, why: a.rs, need: a.upgrade ? `${a.upgrade} (a Cargo.toml change)` : 'no fixed version: replace or remove' });
  }
  for (const row of r.yanked) {
    const key = row.name + '@' + row.version;
    if (seen.has(key)) continue;
    seen.add(key);
    plan.push({ name: row.name, from: row.version, to: null, precise: false, why: 'yanked from crates.io' });
  }
  return { plan, manual };
}

function sh(cmd, args, cwd, opts = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: !!opts.shell, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 0 });
  return { ok: res.status === 0, out: ((res.stdout || '') + (res.stderr || '')).trim(), status: res.status };
}

const tail = (s, n = 60) => s.split('\n').slice(-n).join('\n');

export async function runFix({ r, call, repo, ws, lockRel, testCommand, base, core }) {
  const { plan, manual } = planFixes(r);
  const dir = path.dirname(path.join(ws, lockRel));
  if (!plan.length) {
    core.info(`Fix mode: nothing Cargo can upgrade on its own${manual.length ? ` (${manual.length} need a Cargo.toml change, listed in the summary)` : ''}.`);
    return { applied: [], manual, pr: null };
  }

  const applied = [], failed = [];
  for (const f of plan) {
    const args = ['update', '-p', `${f.name}@${f.from}`];
    if (f.precise) args.push('--precise', f.to);
    const u = sh('cargo', args, dir);
    if (!u.ok) { failed.push({ ...f, error: tail(u.out, 5) }); continue; }
    applied.push(f);
  }
  if (!applied.length) { core.warning('Fix mode: every cargo update failed; see the summary.'); return { applied, failed, manual, pr: null }; }

  // Read the new versions back from the lock file.
  const after = parseLock(readFileSync(path.join(ws, lockRel), 'utf8'));
  for (const f of applied) {
    const now = after.filter(p => p.name === f.name).map(p => p.version);
    f.to = now.includes(f.from) ? f.to : (f.to && now.includes(f.to) ? f.to : now[0] || f.to);
  }

  core.info(`Fix mode: running "${testCommand}"`);
  const t = sh(testCommand, [], dir, { shell: true, timeout: 50 * 60_000 });
  const passed = t.ok;

  // Commit on a fixed branch, force-pushed so one PR stays current.
  const g = (...a) => sh('git', a, ws);
  g('config', 'user.name', 'tensorust-cargo-check[bot]');
  g('config', 'user.email', 'support@tensorust.com');
  g('checkout', '-B', BRANCH);
  g('add', lockRel);
  const msg = `Upgrade ${applied.length} crate${applied.length > 1 ? 's' : ''} to clear advisories and yanked versions\n\n` + applied.map(f => `- ${f.name} ${f.from} -> ${f.to}: ${f.why}`).join('\n');
  const c = g('commit', '-m', msg);
  if (!c.ok) { core.warning('Fix mode: nothing to commit (the lock file did not change).'); return { applied: [], failed, manual, pr: null }; }
  const p = g('push', '--force', 'origin', `HEAD:refs/heads/${BRANCH}`);
  if (!p.ok) { core.warning(`Fix mode: could not push ${BRANCH} (give the workflow permissions: contents: write). ${tail(p.out, 3)}`); return { applied, failed, manual, pr: null, passed }; }

  const body = renderFixBody({ applied, failed, manual, passed, testCommand, testOut: tail(t.out), lockRel });
  const [owner] = repo.split('/');
  const open = await call('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(owner + ':' + BRANCH)}`);
  let pr;
  if (open && open.length) pr = await call('PATCH', `/repos/${repo}/pulls/${open[0].number}`, { body: { body, title: prTitle(applied, passed) } });
  else pr = await call('POST', `/repos/${repo}/pulls`, { body: { title: prTitle(applied, passed), head: BRANCH, base, body, draft: !passed } });
  core.info(`Fix mode: ${pr.html_url}`);
  return { applied, failed, manual, pr: pr.html_url, passed };
}

const prTitle = (applied, passed) => `${passed ? '' : '[tests failing] '}Fix ${applied.length} vulnerable or yanked crate${applied.length > 1 ? 's' : ''}`;

export function renderFixBody({ applied, failed = [], manual = [], passed, testCommand, testOut, lockRel }) {
  let s = `${FIX_MARKER}\n### Tensorust Cargo Check: dependency fixes\n\n`;
  s += passed ? `Tests pass with these upgrades (\`${testCommand}\`). Review and merge.\n\n` : `**Tests fail with these upgrades** (\`${testCommand}\`), so this is a draft. The output is below.\n\n`;
  s += `| Crate | From | To | Why |\n|---|---|---|---|\n` + applied.map(f => `| ${f.name} | ${f.from} | ${f.to || 'latest compatible'} | ${String(f.why).replace(/[|\n]/g, ' ')} |`).join('\n') + '\n\n';
  s += `Only \`${lockRel}\` changes: every upgrade stays inside your Cargo.toml requirements.\n\n`;
  if (manual.length) s += `**Needs a person** (a Cargo.toml change):\n` + manual.map(m => `- ${m.name} ${m.from}: ${m.why}, fixed in ${m.need}`).join('\n') + '\n\n';
  if (failed.length) s += `**Cargo could not apply:**\n` + failed.map(f => `- ${f.name} ${f.from}: ${f.error.replace(/\n/g, ' ')}`).join('\n') + '\n\n';
  if (!passed && testOut) s += `<details><summary>Test output (last lines)</summary>\n\n\`\`\`\n${testOut.slice(-6000)}\n\`\`\`\n</details>\n\n`;
  s += `<sub>This branch is rebuilt on every scheduled run. [Tensorust Cargo Check](https://tensorust.com/tools/cargo-check-action/)</sub>\n`;
  return s;
}
