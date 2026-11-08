// What the repository's automation and SECURITY.md promise, checked by reading them: nothing here
// runs a workflow, and there is no YAML parser, so these are text checks on files this repository
// writes by hand (decision 55). The one exception is the deploy gate's shell script, which is run
// here with git stubbed, because what it does on a failed answer is not visible in its text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

/** A workflow's text without its comment lines, so a rule cannot be met by a comment. */
const code = (text) => text.replace(/^\s*#.*\n/gm, '');
const external = read('.github/workflows/external-links.yml');

/** The script of the first `run: |` step in some text, as the runner is given it. */
function runBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s+run: \|$/.test(l));
  assert.ok(start >= 0, 'a run: | step');
  const indent = lines[start].search(/\S/) + 2;
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== '' && l.search(/\S/) < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const bash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
const NO_BASH = bash.status === 0 && bash.stdout.trim() === 'ok' ? false : 'no bash here; CI runs this on Linux';

/** The gate step, run as the runner runs it (bash -e), with `git ls-remote` answering `answer`. */
function runGate({ tested = '', dispatched = 'cccc', answer }) {
  const dir = mkdtempSync(join(tmpdir(), 'openbill-gate-'));
  const output = join(dir, 'output');
  writeFileSync(output, '');
  writeFileSync(join(dir, 'gate.sh'), `git() { ${answer}; }\n${runBlock(job(pages, 'gate'))}`);
  const r = spawnSync('bash', ['-e', 'gate.sh'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TESTED: tested, DISPATCHED: dispatched, REPOSITORY: 'owner/repo', GITHUB_OUTPUT: 'output' } });
  const out = Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('=')),
  );
  return { status: r.status, stderr: r.stderr, out };
}

const mainAt = (sha) => `printf '%s\\trefs/heads/main\\n' ${sha}`;

// R03: `main=$(git ls-remote … | cut -f1)` took cut's exit status, so a failed answer read as "main
// has moved on": no deploy, and a green run that nothing would follow.
test('the deploy gate stops, red, when it cannot learn which commit main is at', { skip: NO_BASH }, () => {
  for (const [label, answer] of [
    ['git fails', 'echo "fatal: unable to access" >&2; return 128'],
    ['git answers nothing', 'return 0'],
  ]) {
    const r = runGate({ tested: 'aaaa', answer });
    assert.notEqual(r.status, 0, label);
    assert.equal(r.out.deploy, undefined, label);
  }
});

// R07, WF09: older code must never go back on the site.
test('the deploy gate deploys the commit main is at, never an older one, and a dispatch as asked', { skip: NO_BASH }, () => {
  let r = runGate({ tested: 'aaaa', answer: mainAt('aaaa') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { sha: 'aaaa', deploy: 'true' });
  r = runGate({ tested: 'aaaa', answer: mainAt('bbbb') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { sha: 'aaaa', deploy: 'false' });
  assert.match(r.stderr, /main is now at bbbb;/);
  r = runGate({ answer: mainAt('bbbb') });
  assert.deepEqual(r.out, { sha: 'cccc', deploy: 'true' });
});

// R07: the rules below are each stated in a comment of the workflow they are about.
test('every workflow starts from read-only permissions; only the deploy job writes to Pages', () => {
  for (const f of WORKFLOWS) {
    assert.deepEqual(code(read(`.github/workflows/${f}`)).match(/^permissions:.*(?:\n {2}\S.*)*/gm), ['permissions:\n  contents: read'], f);
  }
  assert.match(job(code(pages), 'build'), /\n {4}permissions:\n {6}contents: read\n {6}pages: read\n {4}\S/);
});

test('no required job and no deploy step may fail quietly or run after a failure', () => {
  for (const [f, text] of [
    ['ci.yml', ci],
    ['pages.yml', pages],
    ['external-links.yml', external],
  ]) {
    assert.doesNotMatch(code(text), /continue-on-error|always\(\)/, f);
  }
  const deploy = job(code(pages), 'deploy');
  assert.match(deploy, /\n {4}needs: build\n {4}if: needs\.build\.result == 'success'\n/);
  // Its branch policy is what stops a dispatch from another branch deploying.
  assert.match(deploy, /\n {4}environment:\n {6}name: github-pages\n/);
  // A deployment that has started finishes.
  assert.match(code(pages), /^concurrency:\n {2}group: pages\n {2}cancel-in-progress: false\n/m);
});

test('CI runs every check the deploy relies on, in all three browsers', () => {
  const t = job(code(ci), 'test');
  for (const step of ['node build.js --check', 'node --test', 'node tools/site.mjs --out "$RUNNER_TEMP/openbill-site" --no-og', 'npx playwright install --with-deps chromium firefox webkit', 'npx playwright test']) {
    assert.ok(t.includes(`\n        run: ${step}\n`), step);
  }
});

test('every checkout leaves no credential behind, and the deploy checks out the full history', () => {
  // Each step, from its "- " to the next.
  const checkouts = (text) => code(text).split(/\n(?=\s+- )/).filter((s) => /uses: actions\/checkout@/.test(s));
  for (const f of WORKFLOWS) {
    const found = checkouts(read(`.github/workflows/${f}`));
    assert.ok(found.length > 0, f);
    for (const s of found) assert.match(s, /\n\s+persist-credentials: false$/m, f);
  }
  // The sitemap's dates come from the history; a shallow clone would date every page today.
  const [deployCheckout] = checkouts(job(pages, 'build'));
  assert.match(deployCheckout, /\n\s+fetch-depth: 0$/m);
});

test('one Action is pinned to one commit, under one version, in every workflow', () => {
  const pins = new Map();
  for (const f of WORKFLOWS) {
    for (const [, action, sha, version] of read(`.github/workflows/${f}`).matchAll(/uses: ([\w./-]+)@([0-9a-f]{40}) # (v[\d.]+)$/gm)) {
      assert.doesNotMatch(sha, /^0+$/, `${f}: ${action}`);
      if (!pins.has(action)) pins.set(action, `${sha} ${version}`);
      assert.equal(`${sha} ${version}`, pins.get(action), `${f}: ${action}`);
    }
  }
  assert.ok(pins.size >= 5, `${pins.size} Actions`);
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
