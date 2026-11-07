// What the repository's automation and SECURITY.md promise, checked by reading them: nothing here
// runs a workflow, and there is no YAML parser, so these are text checks on files this repository
// writes by hand (decision 53).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { SITE_CSP } from '../src/build/drugpage.js';
import { cspFor } from '../build.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const WORKFLOWS = readdirSync(join(ROOT, '.github', 'workflows')).filter((f) => f.endsWith('.yml'));
const ci = read('.github/workflows/ci.yml');
const pages = read('.github/workflows/pages.yml');

/** The text of a top-level job: from its key to the next two-space key. */
function job(workflow, name) {
  const m = new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z-]+:\\n|(?![\\s\\S]))`, 'm').exec(workflow);
  assert.ok(m, `job ${name}`);
  return m[0];
}

test('every Action is pinned to a full commit SHA, with its version in a comment', () => {
  let seen = 0;
  for (const f of WORKFLOWS) {
    for (const [line] of read(`.github/workflows/${f}`).matchAll(/^\s*(?:- )?uses:.*$/gm)) {
      seen += 1;
      assert.match(line, /uses: [\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/, `${f}: ${line.trim()}`);
    }
  }
  assert.ok(seen >= 10, `${seen} uses: lines`);
});

test('dependabot watches the Actions and npm, monthly and grouped', () => {
  const d = read('.github/dependabot.yml');
  for (const e of ['github-actions', 'npm']) assert.match(d, new RegExp(`package-ecosystem: ${e}\\n\\s+directory: /\\n\\s+schedule:\\n\\s+interval: monthly\\n\\s+groups:`), e);
});

test('the required checks keep their names, and links does not depend on an outside site', () => {
  assert.match(ci, /^name: CI$/m);
  for (const name of ['test', 'links']) assert.doesNotMatch(job(ci, name), /^    name:/m, `the ${name} job's check is named ${name}`);
  const links = job(ci, 'links');
  assert.doesNotMatch(links, /continue-on-error/);
  assert.doesNotMatch(links, /OPENBILL_CHECK_EXTERNAL/);
  assert.match(links, /OPENBILL_SITE_DIR:/);
  const external = read('.github/workflows/external-links.yml');
  assert.match(external, /schedule:/);
  assert.match(external, /workflow_dispatch:/);
  assert.match(external, /OPENBILL_CHECK_EXTERNAL: "1"/);
  assert.doesNotMatch(external, /^  (test|links):$/m, 'not a job a required check could match');
});

test('CI runs once per pull request commit, and cancels only pull request runs', () => {
  assert.match(ci, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:\n/m);
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(job(ci, 'test'), /timeout 180 npm ci \|\| \{.*timeout 180 npm ci; \}/);
});

test('the site deploys only what CI passed on a push to main of this repository', () => {
  assert.match(pages, /^on:\n  workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]\n  workflow_dispatch:\n/m);
  const gate = job(pages, 'gate');
  for (const needed of ["conclusion == 'success'", "event == 'push'", 'head_repository.full_name == github.repository']) assert.ok(gate.includes(needed), needed);
  const build = job(pages, 'build');
  assert.match(build, /needs: gate\n\s+if: needs\.gate\.outputs\.deploy == 'true'/);
  assert.match(build, /ref: \$\{\{ needs\.gate\.outputs\.sha \}\}/);
  assert.match(build, /run: node --test/, 'the deploy keeps its own test step');
  const deploy = job(pages, 'deploy');
  assert.match(deploy, /needs: build/);
  assert.match(deploy, /pages: write\n\s+id-token: write/);
  for (const other of ['gate', 'build']) assert.doesNotMatch(job(pages, other), /pages: write|id-token: write/, `${other} holds no write scope`);
});

test('the deploy refuses a site over the 900 MB guard', () => {
  const build = job(pages, 'build');
  assert.match(build, /bytes=\$\(du -sb _site \| cut -f1\)/);
  assert.match(build, /limit=900000000\n/);
  assert.match(build, /if \[ "\$\{bytes\}" -gt "\$\{limit\}" \]; then[\s\S]*?exit 1/);
});

test('SECURITY.md states the CSP of both kinds of page, as the builders write them', () => {
  const doc = read('SECURITY.md').replace(/\s+/g, ' ');
  assert.ok(doc.includes(`\`${SITE_CSP}\``), 'the static pages: SITE_CSP, exactly');
  const app = cspFor(['script'], ['style']).replace(/'sha256-[^']*'/g, "'sha256-…'");
  assert.ok(doc.includes(`\`${app}\``), `the app pages: ${app}`);
  assert.match(cspFor([], ['style']), /script-src 'none'/);
  assert.ok(doc.includes("`script-src 'none'` on `methodology.html`"));
  assert.doesNotMatch(doc, /Every generated page carries a CSP meta tag built from/, 'the sentence that was false for the static pages');
  assert.doesNotMatch(doc, /The workflow runs with read-only repository permissions/, 'and the one that was false for the deploy job');
  assert.match(doc, /Only the deploy job holds `pages: write` and `id-token: write`/);
});
