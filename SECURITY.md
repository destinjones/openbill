# Security policy

OpenBill is a static page. It has no server, no accounts, no cookies and no runtime network
requests. The risks are in what it renders and in what its builders read.

## Supported versions

Only the current `main` branch and the `openbill.html` built from it. There are no release
branches and no backports.

## In scope

- **XSS via data.** Most strings on the page come from government files nobody here
  controls: drug names, labeler names, package descriptions. Everything rendered goes
  through `esc()` in `src/core/esc.js`, which escapes `& < > " '` and backtick. The data is
  inlined deflate-raw compressed and base64-encoded inside a small JSON descriptor, so no
  source string appears in the page's HTML; the page unpacks it and reads it with
  `JSON.parse`, never as code. A source value that renders as markup or runs script is a
  vulnerability.
- **The Content Security Policy.** Every generated page carries a CSP meta tag built from
  the sha256 hashes of its own inline script and style:
  `default-src 'none'`, no `unsafe-inline`, no `eval`, `base-uri 'none'`,
  `form-action 'none'`. Fonts and images are allowed only as `data:` URIs. Any way to run
  script, load a resource or send a request despite it is a vulnerability.
- **Zero runtime dependencies.** The page loads nothing from anywhere; code, fonts and data
  are inlined. The only dependency is the dev-only `@playwright/test`, and the builders use
  the Python standard library. A request leaving the page is a vulnerability.
- **Data integrity.** Each fetcher records the sha256, size and ETag of every download in
  `tools/cache/manifest.json`, and the builders refuse to build from a file whose hash
  doesn't match. Downloaded files are untrusted data: parsed with the standard library,
  never executed. A way to make a builder run code from a downloaded file, write outside the
  repo, or build from a file that fails its hash check is a vulnerability. The page checks
  its unpacked inline data against the byte count and sha256 the build recorded and shows no
  figures when they differ; a way to get altered data past that check is a vulnerability.
- **CI.** The workflow runs with read-only repository permissions. A way to get write
  access or secrets from a pull request is a vulnerability.

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
- Framing a copy you host yourself. A CSP in a meta tag can't set `frame-ancestors`, so
  clickjacking protection for a hosted copy has to come from that server's headers.
- Anything that needs a compromised machine or a malicious browser extension first.
