// GitHub glue: find the Cargo files a pull request touches, run the checks, post or update one comment.
import * as core from '@actions/core';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseLock, parseManifest } from './parse.js';
import { runCheck, resolveManifest } from './check.js';
import { renderReport, headline, MARKER, LOCKED_MESSAGE } from './render.js';
import { runFix } from './fix.js';

const VERIFY_URL = 'https://shop.tensorust.com/api/cargo-check/verify';
const CARGO_FILE = /(^|\/)Cargo\.(toml|lock)$/;

function gh(token) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  return async function call(method, route, { body, accept, allow404 } = {}) {
    const r = await fetch(route.startsWith('http') ? route : api + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tensorust-cargo-check', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404 && allow404) return null;
    if (!r.ok) { const e = new Error(`GitHub ${method} ${route}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; }
    if (r.status === 204) return null;
    return (accept || '').includes('raw') ? r.text() : r.json();
  };
}

async function paginate(call, route) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const sep = route.includes('?') ? '&' : '?';
    const items = await call('GET', `${route}${sep}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

export async function verifyKey(key, repo, fetchImpl = fetch) {
  if (!key) return { valid: false, reason: 'missing' };
  try {
    const r = await fetchImpl(`${VERIFY_URL}?key=${encodeURIComponent(key)}&repo=${encodeURIComponent(repo)}`, { headers: { 'User-Agent': 'tensorust-cargo-check' }, signal: AbortSignal.timeout(15000) });
    if (r.status >= 500) return { valid: true, reason: 'verify-unavailable' }; // our outage never blocks your PR
    const j = await r.json().catch(() => ({}));
    return { valid: j.valid === true, reason: j.valid === true ? 'ok' : 'invalid' };
  } catch {
    return { valid: true, reason: 'verify-unavailable' };
  }
}

const parentDirs = file => {
  const parts = file.split('/').slice(0, -1), out = [];
  for (let i = parts.length; i >= 0; i--) out.push(parts.slice(0, i).join('/'));
  return out;
};
const join = (dir, f) => (dir ? dir + '/' + f : f);

async function upsertComment(call, repo, number, body) {
  const comments = await paginate(call, `/repos/${repo}/issues/${number}/comments`);
  const mine = comments.find(c => typeof c.body === 'string' && c.body.startsWith(MARKER));
  if (mine) { if (mine.body !== body) await call('PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body: { body } }); return mine.html_url; }
  const c = await call('POST', `/repos/${repo}/issues/${number}/comments`, { body: { body } });
  return c.html_url;
}

function failReasons(failOn, r) {
  const out = [];
  if (failOn.includes('advisories') && r.security.length) out.push(`${r.security.length} security advisories`);
  if (failOn.includes('yanked') && r.yanked.length) out.push(`${r.yanked.length} yanked versions`);
  if (failOn.includes('unmaintained') && r.notices.length) out.push(`${r.notices.length} unmaintained or unsound notices`);
  if (failOn.includes('copyleft') && r.copyleft.length) out.push(`${r.copyleft.length} copyleft licenses`);
  return out;
}

export async function run() {
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
  const failOn = core.getInput('fail-on').split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(s => s && s !== 'none');
  const key = core.getInput('license-key').trim();
  const lockInput = core.getInput('lockfile').trim();
  const maxApiCalls = Math.max(0, parseInt(core.getInput('max-api-calls') || '60', 10) || 0);
  const wantComment = (core.getInput('comment') || 'true').toLowerCase() !== 'false';
  const wantFix = (core.getInput('fix') || 'false').toLowerCase() === 'true';
  const testCommand = core.getInput('test-command') || 'cargo test';
  const repo = process.env.GITHUB_REPOSITORY;
  const event = process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pr = event.pull_request;
  const isPrivate = !!(event.repository && event.repository.private);
  const call = gh(token);

  if (isPrivate) {
    const v = await verifyKey(key, repo);
    if (v.reason === 'verify-unavailable') core.warning('Could not reach the Tensorust license server; running anyway.');
    if (!v.valid) {
      core.notice(LOCKED_MESSAGE.replace(MARKER + '\n', '').trim());
      if (pr && wantComment) { try { await upsertComment(call, repo, pr.number, key ? LOCKED_MESSAGE.replace('so it needs a license key', 'and the license key given is not valid for ' + repo + '. It needs a key') : LOCKED_MESSAGE); } catch (e) { core.warning(`Could not comment: ${e.message}`); } }
      return;
    }
  }

  // Not a pull request (push, schedule, workflow_dispatch): check the checked-out Cargo.lock, report in the job summary.
  if (!pr) {
    const ws = process.env.GITHUB_WORKSPACE || process.cwd();
    const lockPath = path.join(ws, lockInput || 'Cargo.lock');
    if (!existsSync(lockPath)) { core.info(`No pull request and no ${lockInput || 'Cargo.lock'} in the workspace (run actions/checkout first). Nothing to check.`); return; }
    const r = await runCheck({ packages: parseLock(readFileSync(lockPath, 'utf8')), fetch, maxApiCalls });
    let md = renderReport(r, { source: '`' + (lockInput || 'Cargo.lock') + '`', failOn });
    if (wantFix) {
      const base = (event.repository && event.repository.default_branch) || process.env.GITHUB_REF_NAME || 'main';
      try {
        const f = await runFix({ r, call, repo, ws, lockRel: lockInput || 'Cargo.lock', testCommand, base, core });
        core.setOutput('fix-pr', f.pr || '');
        if (f.pr) md += `
**Fix pull request:** ${f.pr} (${f.passed ? 'tests pass' : 'tests fail, opened as a draft'})
`;
        else if (f.manual && f.manual.length) md += `
**Fix mode:** nothing Cargo can upgrade inside your requirements; ${f.manual.length} need a Cargo.toml change.
`;
      } catch (e) { core.warning(`Fix mode failed: ${e.message}`); }
    }
    await core.summary.addRaw(md).write();
    return finish(r, failOn);
  }

  const number = pr.number, headSha = pr.head.sha, baseSha = pr.base.sha;
  const files = (await paginate(call, `/repos/${repo}/pulls/${number}/files`)).filter(f => CARGO_FILE.test(f.filename));
  if (!files.length && !lockInput) { core.info('This pull request does not touch Cargo.toml or Cargo.lock. Nothing to check.'); return; }

  const read = async (p, ref) => {
    let t = await call('GET', `/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`, { accept: 'application/vnd.github.raw+json', allow404: true }).catch(e => { if (e.status === 404) return null; throw e; });
    if (t == null && ref === headSha) t = await call('GET', `/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=refs/pull/${number}/head`, { accept: 'application/vnd.github.raw+json', allow404: true }).catch(() => null);
    return t;
  };

  // Which Cargo.lock files to check: the input, every changed one, and the nearest one above each changed Cargo.toml.
  const locks = new Set();
  if (lockInput) locks.add(lockInput.replace(/^\.\//, ''));
  else {
    for (const f of files) if (/Cargo\.lock$/.test(f.filename) && f.status !== 'removed') locks.add(f.filename);
    for (const f of files.filter(f => /Cargo\.toml$/.test(f.filename))) {
      for (const dir of parentDirs(f.filename)) {
        const p = join(dir, 'Cargo.lock');
        if (locks.has(p)) break;
        if (await read(p, headSha) != null) { locks.add(p); break; }
      }
    }
  }

  // Direct dependencies added to any changed Cargo.toml.
  const directAdded = [];
  const manifests = files.filter(f => /Cargo\.toml$/.test(f.filename) && f.status !== 'removed');
  const headManifests = {};
  for (const f of manifests) {
    const head = await read(f.filename, headSha);
    if (head == null) continue;
    headManifests[f.filename] = head;
    const before = f.status === 'added' ? '' : (await read(f.previous_filename || f.filename, baseSha)) || '';
    const had = new Set(parseManifest(before).map(d => d.kind + ':' + d.pkg));
    for (const d of parseManifest(head)) if (!d.local && !had.has(d.kind + ':' + d.pkg) && !directAdded.some(x => x.pkg === d.pkg)) directAdded.push(d);
  }

  let packages = [], basePackages = null, source;
  if (locks.size) {
    const seen = new Set(), baseSeen = new Map();
    let anyBase = false;
    for (const p of locks) {
      const head = await read(p, headSha);
      if (head == null) { core.warning(`${p} not found at ${headSha}`); continue; }
      for (const x of parseLock(head)) { const k = x.name + '@' + x.version; if (!seen.has(k)) { seen.add(k); packages.push(x); } }
      const base = await read(p, baseSha);
      if (base != null) { anyBase = true; for (const x of parseLock(base)) baseSeen.set(x.name + '@' + x.version, x); }
    }
    basePackages = anyBase ? [...baseSeen.values()] : [];
    source = [...locks].map(p => '`' + p + '`').join(', ');
  } else {
    // No lock file in the repo (a library): resolve each Cargo.toml requirement the way Cargo would today.
    const deps = Object.values(headManifests).flatMap(parseManifest);
    const res = await resolveManifest(fetch, deps);
    packages = res.packages;
    source = Object.keys(headManifests).map(p => '`' + p + '`').join(', ') + ' (no Cargo.lock, so each requirement is resolved to the version Cargo picks today)';
    if (res.unresolved.length) core.warning(`No published version matches: ${res.unresolved.map(d => d.pkg + ' ' + d.req).join(', ')}`);
  }
  if (!packages.length) { core.info('No crates.io packages to check.'); return; }

  core.info(`Checking ${packages.length} crates.io packages from ${source}`);
  const r = await runCheck({ packages, basePackages, directAdded, fetch, maxApiCalls });
  const md = renderReport(r, { source, failOn });
  await core.summary.addRaw(md).write();
  if (wantComment) {
    try { core.info(`Comment: ${await upsertComment(call, repo, number, md)}`); }
    catch (e) { core.warning(`Could not post the PR comment (${e.status === 403 ? 'the token is read-only here, as on pull requests from forks; add permissions: pull-requests: write' : e.message}). The report is in the job summary.`); }
  }
  return finish(r, failOn);
}

function finish(r, failOn) {
  core.setOutput('advisories', String(r.security.length));
  core.setOutput('yanked', String(r.yanked.length));
  core.setOutput('behind', String(r.behind.length));
  core.setOutput('new-dependencies', String(r.newPackages.length));
  core.setOutput('summary', headline(r));
  const why = failReasons(failOn, r);
  if (why.length) core.setFailed(`Cargo Check: ${why.join(', ')}.`);
  else core.info(`Cargo Check: ${headline(r)}.`);
  return r;
}
