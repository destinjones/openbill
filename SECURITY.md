# Security policy

OpenBill is static files: one self-contained page, and a website of static pages built from the
same data. It has no server, no accounts and no cookies. The risks are in what it renders, in what
its builders read and in the jobs that build and publish it.

## Supported versions

Only the current `main` branch, and the `openbill.html` and website built from it. There are no
release branches and no backports.

## In scope

- **XSS via data.** Most strings on the page come from government files nobody here
  controls: drug names, labeler names, package descriptions. Everything rendered goes
  through `esc()` in `src/core/esc.js`, which escapes `& < > " '` and backtick. The data is
  inlined deflate-raw compressed and base64-encoded inside a small JSON descriptor, so no
  source string appears in the page's HTML; the page unpacks it and reads it with
  `JSON.parse`, never as code. A source value that renders as markup or runs script is a
  vulnerability.
- **The Content Security Policy.** Every generated page carries a CSP meta tag, of one of two
  kinds. Any way to run script, load a resource from another origin or send a request despite
  it is a vulnerability.
  - `openbill.html` and `methodology.html` have all their code, fonts and data inlined. Their CSP
    is built from the sha256 hashes of their own inline script and style:
    `default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'`
    (`script-src 'none'` on `methodology.html`, which has no script). No `unsafe-inline`, no `eval`.
  - The website's static pages (drug, class and A–Z pages, the press kit, `404.html`) have no
    script that runs, and load their stylesheet and fonts from the same origin:
    `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'`.
    Their JSON-LD block is data, in a `type="application/ld+json"` script the browser never runs.
- **No third-party requests.** `openbill.html` loads nothing from anywhere, and the static pages
  load only their own stylesheet, fonts and preview image. The only dependency is the dev-only
  `@playwright/test`, and the builders use the Python standard library. A page making a request
  to another origin is a vulnerability.
- **Data integrity.** Each fetcher records the sha256, size and ETag of every download in
  `tools/cache/manifest.json`, and the builders refuse to build from a file whose hash
  doesn't match. Downloaded files are untrusted data: parsed with the standard library,
  never executed. A way to make a builder run code from a downloaded file, write outside the
  repo, or build from a file that fails its hash check is a vulnerability. The page checks
  its unpacked inline data against the byte count and sha256 the build recorded and shows no
  figures when they differ; a way to get altered data past that check is a vulnerability.
- **The site builder.** `tools/site.mjs` turns the data into pages, and renders each preview image
  in a local Chromium with JavaScript off and every request aborted. A data value that gets
  script run during a build, a request made from one, or a file written outside its `--out`
  folder is a vulnerability.
- **CI and the deploy.** The CI workflows and the deploy's build job run with read-only
  repository permissions. Only the deploy job holds `pages: write` and `id-token: write`, and it
  runs nothing but GitHub's `deploy-pages` action on what the build job uploaded. Every action is
  pinned to a full commit SHA. The deploy runs only after CI has passed on a push to `main` of this
  repository. A way to get write access or secrets from a pull request, or to publish a commit CI
  did not pass, is a vulnerability.

## Reporting a vulnerability

Report it privately through GitHub:
<https://github.com/destinjones/openbill/security/advisories/new>

Please don't open a public issue. Include what you found, how to reproduce it (a crafted
source row or URL is ideal) and what it lets an attacker do.

## What to expect

OpenBill is a volunteer project. There is no security team, no bug bounty and no
guaranteed response time. A maintainer will try to acknowledge your report within a week,
and will tell you if a fix is going to take longer than that. We aim to fix a confirmed
issue before it is disclosed, and we credit reporters in the advisory and the changelog
unless you ask us not to. If you hear nothing for two weeks, add a comment to your advisory.

## Not a vulnerability

- **A wrong price**, a stale file or a missed match. Those are public on purpose: use the
  [wrong price form](https://github.com/destinjones/openbill/issues/new?template=wrong-price.yml).
- Errors in the CMS or FDA data themselves. Report them the same way; we'll point to the
  publisher.
- Framing a page, on the official site or on a copy you host yourself. A CSP in a meta tag can't
  set `frame-ancestors`, and GitHub Pages sends no such header, so the official site can be put in
  a frame too. No page has an action a frame could trick a reader into taking: no account, no
  form that submits anywhere. Protection for a hosted copy has to come from that server's headers.
- Anything that needs a compromised machine or a malicious browser extension first.
