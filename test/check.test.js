// Runs against fixture Cargo.lock / Cargo.toml files made by `cargo generate-lockfile`, replaying real crates.io index,
// crates.io API and OSV answers recorded by scripts/record-fixtures.mjs. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLock, parseManifest, indexPath, parseIndex } from '../src/parse.js';
import { ranges, satisfies, parseVersion, resolve, breakingBehind } from '../src/semver.js';
import { runCheck, resolveManifest } from '../src/check.js';
import { renderReport, MARKER, LOCKED_MESSAGE } from '../src/render.js';
import { verifyKey } from '../src/main.js';

const F = new URL('./fixtures/', import.meta.url);
const read = f => readFileSync(new URL(f, F), 'utf8');
const tape = JSON.parse(read('responses.json'));
const replay = async (url, opts = {}) => {
  const hit = tape[url + (opts.body ? ' ' + opts.body : '')];
  if (!hit) return new Response('not recorded', { status: 404 });
  return new Response(hit.body, { status: hit.status });
};
const noSleep = async () => {};

test('parses every crates.io package in a v4 Cargo.lock and skips the local crate', () => {
  const pk = parseLock(read('head.Cargo.lock'));
  assert.ok(pk.length > 40);
  assert.ok(!pk.some(p => p.name === 'demo'));
  assert.deepEqual(pk.find(p => p.name === 'time'), { name: 'time', version: '0.3.20' });
  assert.deepEqual(pk.find(p => p.name === 'smallvec'), { name: 'smallvec', version: '1.6.0' });
});

test('parses Cargo.toml dependency forms', () => {
  const d = parseManifest(`[package]\nname="x"\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\nfoo = { path = "../foo" }\nbar = { workspace = true }\nrenamed = { package = "tokio", version = "1" }\n"quoted" = "0.2"\n[dev-dependencies]\ncriterion = "0.5"\n[target.'cfg(unix)'.dependencies]\nlibc = "0.2"\n[dependencies.reqwest]\nversion = "0.12"\nfeatures = ["json"]\n[workspace.dependencies]\nanyhow = "1"\n`);
  const by = Object.fromEntries(d.map(x => [x.name, x]));
  assert.equal(by.serde.req, '1.0');
  assert.equal(by.foo.local, 'path');
  assert.equal(by.bar.local, 'workspace');
  assert.equal(by.renamed.pkg, 'tokio');
  assert.equal(by.quoted.req, '0.2');
  assert.equal(by.criterion.kind, 'dev-dependencies');
  assert.equal(by.libc.req, '0.2');
  assert.equal(by.reqwest.req, '0.12');
  assert.equal(by.anyhow.kind, 'workspace');
});

test('Cargo semver rules', () => {
  const ok = (req, v) => satisfies(parseVersion(v), ranges(req));
  assert.ok(ok('1.2', '1.9.0')); assert.ok(!ok('1.2', '2.0.0')); assert.ok(!ok('1.2', '1.1.9'));
  assert.ok(ok('0.3', '0.3.9')); assert.ok(!ok('0.3', '0.4.0'));
  assert.ok(ok('0.0.3', '0.0.3')); assert.ok(!ok('0.0.3', '0.0.4'));
  assert.ok(ok('~1.4.2', '1.4.9')); assert.ok(!ok('~1.4.2', '1.5.0'));
  assert.ok(ok('=0.3.20', '0.3.20')); assert.ok(!ok('=0.3.20', '0.3.21'));
  assert.ok(ok('>=1, <2', '1.5.0')); assert.ok(!ok('>=1, <2', '2.0.0'));
  assert.ok(ok('1.*', '1.7.0')); assert.ok(!ok('1', '2.0.0-alpha'));
  assert.ok(!ok('1', '1.5.0-beta.1'));
  const vs = ['1.0.0', '1.2.0', '1.3.0', '2.0.0'].map(n => ({ num: n, v: parseVersion(n), yanked: n === '1.3.0' }));
  assert.equal(resolve('1', vs).num, '1.2.0');
  assert.ok(breakingBehind({ v: parseVersion('0.7.3') }, { v: parseVersion('0.9.2') }));
  assert.ok(!breakingBehind({ v: parseVersion('1.0.1') }, { v: parseVersion('1.9.0') }));
  assert.ok(breakingBehind({ v: parseVersion('0.0.3') }, { v: parseVersion('0.0.4') }));
});

test('sparse index paths', () => {
  assert.equal(indexPath('a'), '1/a'); assert.equal(indexPath('ab'), '2/ab');
  assert.equal(indexPath('abc'), '3/a/abc'); assert.equal(indexPath('Serde'), 'se/rd/serde');
  assert.deepEqual(parseIndex('{"vers":"1.0.0","yanked":false,"rust_version":"1.60"}\n{"vers":"1.0.1","yanked":true}\n'),
    [{ num: '1.0.0', yanked: false, msrv: '1.60' }, { num: '1.0.1', yanked: true, msrv: null }]);
});

test('lock file check finds the advisories, the unsound notice, licenses and new packages', async () => {
  const r = await runCheck({ packages: parseLock(read('head.Cargo.lock')), basePackages: parseLock(read('base.Cargo.lock')),
    directAdded: [{ name: 'chrono', pkg: 'chrono', req: '0.4', kind: 'dependencies' }], fetch: replay, sleep: noSleep, maxApiCalls: 100, tidx: null });
  const sec = r.security.map(x => x.row.name + ' ' + x.a.rs);
  assert.ok(sec.includes('time RUSTSEC-2026-0009'), sec.join(', '));
  assert.ok(sec.includes('smallvec RUSTSEC-2021-0003'), sec.join(', '));
  const sv = r.security.find(x => x.row.name === 'smallvec');
  assert.ok(sv.a.fixed.includes('1.6.1'));
  assert.equal(sv.a.upgrade, '1.6.1');
  // rand 0.7.3: RUSTSEC-2026-0097 is an "unsound" notice, reported apart from security advisories even though GHSA lists it too.
  assert.ok(!sec.some(s => s.startsWith('rand ')));
  assert.ok(r.notices.some(x => x.row.name === 'rand' && x.a.informational === 'unsound' && x.a.upgrade === '0.8.6'));
  // GHSA aliases are folded into their RUSTSEC id, so each advisory is listed once.
  assert.equal(r.security.filter(x => x.row.name === 'smallvec').length, 1);
  assert.ok(r.behind.some(x => x.name === 'rand'));
  assert.ok(r.rows.every(x => x.license !== undefined), 'every license resolved');
  assert.ok(r.msrv && r.msrv.version);
  const newNames = r.newPackages.map(x => x.name);
  assert.ok(newNames.includes('chrono') && newNames.includes('rand') && !newNames.includes('serde'));
  const md = renderReport(r, { source: '`Cargo.lock`', checkedAt: '2026-10-24', failOn: ['advisories'] });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /Security advisories \(\d+\)/);
  assert.match(md, /https:\/\/tensorust\.com\/rust\/advisories\/rustsec-2026-0009\//);
  assert.match(md, /https:\/\/tensorust\.com\/crates\/time\//);
  assert.match(md, /New dependencies in this PR \(1 direct/);
  assert.ok(md.length < 65000);
});

test('links follow the tensorust.com page index when it is available', async () => {
  const tidx = { advisories: new Set(['rustsec-2021-0003']), features: new Set(['rand']), crates: new Set(['rand']), licenses: {} };
  const r = await runCheck({ packages: parseLock(read('head.Cargo.lock')), basePackages: parseLock(read('base.Cargo.lock')), fetch: replay, sleep: noSleep, maxApiCalls: 100, tidx });
  const md = renderReport(r, { source: '`Cargo.lock`' });
  assert.match(md, /tensorust\.com\/rust\/advisories\/rustsec-2021-0003\//);
  assert.match(md, /rustsec\.org\/advisories\/RUSTSEC-2026-0009\.html/);
  assert.match(md, /tensorust\.com\/rust\/features\/rand\//);
  assert.match(md, /crates\.io\/crates\/time/);
});

test('max-api-calls caps crates.io license lookups and says so', async () => {
  const r = await runCheck({ packages: parseLock(read('head.Cargo.lock')), fetch: replay, sleep: noSleep, maxApiCalls: 3, tidx: null });
  assert.ok(r.notes.some(n => /Licenses not checked for \d+ crates/.test(n)));
});

test('Cargo.toml without a lock resolves requirements like cargo does', async () => {
  const res = await resolveManifest(replay, parseManifest(read('head.Cargo.toml')));
  const by = Object.fromEntries(res.packages.map(p => [p.name, p.version]));
  assert.equal(by.time, '0.3.20');
  assert.equal(by.smallvec, '1.6.0');
  assert.match(by.rand, /^0\.7\./);
  const r = await runCheck({ packages: res.packages, fetch: replay, sleep: noSleep, maxApiCalls: 100, tidx: null });
  assert.ok(r.security.some(x => x.row.name === 'time'));
});

test('private repo message is one line and the key check fails open on our outage', async () => {
  assert.equal(LOCKED_MESSAGE.trim().split('\n').length, 2); // marker + one line
  const down = async () => new Response('', { status: 503 });
  assert.equal((await verifyKey('tcc_x', 'a/b', down)).valid, true);
  const no = async () => new Response('{"valid":false}', { status: 200 });
  assert.equal((await verifyKey('tcc_x', 'a/b', no)).valid, false);
  assert.equal((await verifyKey('', 'a/b', no)).valid, false);
});

import { compatible, planFixes, renderFixBody } from '../src/fix.js';

test('fix mode: caret compatibility matches Cargo', () => {
  assert.equal(compatible('1.6.0', '1.6.1'), true);
  assert.equal(compatible('1.6.0', '2.0.0'), false);
  assert.equal(compatible('0.3.20', '0.3.23'), true);
  assert.equal(compatible('0.3.20', '0.4.0'), false);
  assert.equal(compatible('0.0.3', '0.0.4'), false);
});

test('fix mode: plans in-requirement upgrades, routes breaking ones to a person', () => {
  const row = (name, version) => ({ name, version });
  const r = {
    security: [
      { row: row('smallvec', '1.6.0'), a: { rs: 'RUSTSEC-2021-0003', summary: 'overflow', upgrade: '1.6.1' } },
      { row: row('old', '0.2.0'), a: { rs: 'RUSTSEC-X', upgrade: '0.3.0' } },
      { row: row('nofix', '1.0.0'), a: { rs: 'RUSTSEC-Y', upgrade: null } },
    ],
    yanked: [row('y', '1.2.3'), row('smallvec', '1.6.0')],
  };
  const { plan, manual } = planFixes(r);
  assert.deepEqual(plan.map(p => [p.name, p.to, p.precise]), [['smallvec', '1.6.1', true], ['y', null, false]]);
  assert.deepEqual(manual.map(m => m.name), ['old', 'nofix']);
  const body = renderFixBody({ applied: plan, manual, passed: false, testCommand: 'cargo test', testOut: 'boom', lockRel: 'Cargo.lock' });
  assert.match(body, /draft/);
  assert.match(body, /Needs a person/);
});
