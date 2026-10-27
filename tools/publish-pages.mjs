// Publish a tested checkout without discarding either branch's history.
// --update-main also publishes the data commit; both refs move atomically.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--update-main')) {
  throw new Error('Usage: node tools/publish-pages.mjs [--update-main]');
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('rev-parse', '--is-shallow-repository') !== 'false') {
  throw new Error('Publication requires complete history: set checkout fetch-depth to 0.');
}

git('fetch', '--no-tags', 'origin',
  'refs/heads/main:refs/remotes/origin/main',
  'refs/heads/gh-pages:refs/remotes/origin/gh-pages');
const source = git('rev-parse', 'HEAD');
const main = git('rev-parse', 'refs/remotes/origin/main');
const pages = git('rev-parse', 'refs/remotes/origin/gh-pages');

// Refuse an outdated checkout rather than publishing over a newer main.
git('merge-base', '--is-ancestor', main, source);
const tree = git('rev-parse', `${source}^{tree}`);
let published = pages;
if (tree !== git('rev-parse', `${pages}^{tree}`)) {
  // The Pages workflow may have its own cache-version commit. Retain it as
  // a parent while publishing exactly the tested source tree, without force.
  published = git('commit-tree', tree, '-p', pages, '-p', source,
    '-m', `Publish ${source} to GitHub Pages`);
}

const mainTarget = args.includes('--update-main') ? source : main;
// Including main even when unchanged rejects a concurrent update to either
// branch. A failed publication must not leave only main updated again.
git('push', '--atomic', 'origin',
  `${mainTarget}:refs/heads/main`, `${published}:refs/heads/gh-pages`);
const summary = `Source commit: ${source}\nMain commit: ${mainTarget}\nPages commit: ${published}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`text\n${summary}\`\`\`\n`);
}
