import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publisher = fileURLToPath(new URL('../tools/publish-pages.mjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'game3-publish-test-'));
  t.after(() => {
    const withinTemp = relative(tmpdir(), root);
    assert.ok(!isAbsolute(withinTemp) && !withinTemp.startsWith('..'));
    rmSync(root, { recursive: true, force: true });
  });
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  mkdirSync(work);
  git(root, 'init', '--bare', remote);
  git(work, 'init', '--initial-branch=main');
  git(work, 'config', 'user.name', 'Publication test');
  git(work, 'config', 'user.email', 'publication-test@example.invalid');
  const commit = text => {
    writeFileSync(join(work, 'data.json'), JSON.stringify({ text }) + '\n');
    git(work, 'add', 'data.json');
    git(work, 'commit', '-m', text);
    return git(work, 'rev-parse', 'HEAD');
  };
  const initial = commit('initial');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '--atomic', 'origin', 'HEAD:main', 'HEAD:gh-pages');
  const ref = branch => git(root, '--git-dir', remote, 'rev-parse', branch);
  const publish = (args = ['--update-main'], cwd = work) => spawnSync(
    process.execPath, [publisher, ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  const success = result => assert.equal(result.status, 0, result.stderr);
  return { root, remote, work, commit, initial, ref, publish, success };
}

test('publication updates both refs with the complete tested tree and history', t => {
  const f = fixture(t);
  const source = f.commit('updated data');
  f.success(f.publish());
  assert.equal(f.ref('main'), source);
  assert.equal(f.ref('gh-pages^{tree}'), f.ref('main^{tree}'));
  git(f.work, 'merge-base', '--is-ancestor', f.initial, f.ref('gh-pages'));
  git(f.work, 'merge-base', '--is-ancestor', source, f.ref('gh-pages'));
  git(f.root, '--git-dir', f.remote, 'fsck', '--full');
});

test('publication recovers an already-pushed main without another data change and is idempotent', t => {
  const f = fixture(t);
  const source = f.commit('previously unpublished data');
  git(f.work, 'push', 'origin', 'HEAD:main');
  assert.equal(f.ref('gh-pages'), f.initial);
  f.success(f.publish());
  assert.equal(f.ref('main'), source);
  assert.equal(f.ref('gh-pages^{tree}'), f.ref('main^{tree}'));
  const published = f.ref('gh-pages');
  f.success(f.publish());
  assert.equal(f.ref('gh-pages'), published);
});

test('publication retains a separate Pages version commit without changing main in deploy mode', t => {
  const f = fixture(t);
  git(f.work, 'switch', '-c', 'pages-version');
  const priorPages = f.commit('previous Pages cache version');
  git(f.work, 'push', 'origin', 'HEAD:gh-pages');
  git(f.work, 'switch', 'main');
  const source = f.commit('new Pages cache version');
  f.success(f.publish([]));
  assert.equal(f.ref('main'), f.initial);
  assert.equal(f.ref('gh-pages^{tree}'), git(f.work, 'rev-parse', `${source}^{tree}`));
  const parents = git(f.work, 'show', '-s', '--format=%P', f.ref('gh-pages')).split(' ');
  assert.deepEqual(parents, [priorPages, source]);
});

test('a rejected Pages update leaves both remote branches unchanged', t => {
  const f = fixture(t);
  f.commit('must not partially publish');
  const hook = join(f.remote, 'hooks', 'update');
  writeFileSync(hook, '#!/bin/sh\nif [ "$1" = "refs/heads/gh-pages" ]; then exit 1; fi\n');
  chmodSync(hook, 0o755);
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hook declined|atomic push failure/);
  assert.equal(f.ref('main'), f.initial);
  assert.equal(f.ref('gh-pages'), f.initial);
});

test('an outdated checkout cannot replace newer main or published data', t => {
  const f = fixture(t);
  const stale = f.commit('stale checkout');
  git(f.work, 'push', 'origin', 'HEAD:main');
  const newer = f.commit('newer main');
  git(f.work, 'push', 'origin', 'HEAD:main');
  git(f.work, 'switch', '--detach', stale);
  assert.notEqual(f.publish().status, 0);
  assert.equal(f.ref('main'), newer);
  assert.equal(f.ref('gh-pages'), f.initial);
});

test('a shallow checkout is rejected before any publication', t => {
  const f = fixture(t);
  const shallow = join(f.root, 'shallow');
  git(f.root, 'clone', '--depth=1', '--branch=main', pathToFileURL(f.remote).href, shallow);
  const result = f.publish(['--update-main'], shallow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fetch-depth to 0/);
  assert.equal(f.ref('main'), f.initial);
  assert.equal(f.ref('gh-pages'), f.initial);
});
