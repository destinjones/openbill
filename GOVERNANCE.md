# Governance

OpenBill is a small volunteer project. This page says who decides things, how, and what
can't be decided away.

## Maintainers

- [@destinjones](https://github.com/destinjones), project owner

Maintainers review and merge pull requests, triage issues, refresh the data, check
wrong-price reports and handle security reports.

## How decisions are made

- **Day to day:** in issues and pull requests. A maintainer merges a pull request when CI
  passes and the change follows the house rules.
- **Bigger changes:** anything that changes the contract, adds or drops a source, or
  changes how a number is computed comes as a pull request that updates
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and adds a numbered entry to
  [docs/DECISIONS.md](docs/DECISIONS.md) (context, decision, consequences). Entries aren't
  rewritten later; a new entry supersedes or amends an old one, and the old one gets a
  one-line note pointing at it.
- **Disagreement:** argue it out on the issue. If maintainers still disagree, the project
  owner decides and records why in [docs/DECISIONS.md](docs/DECISIONS.md).

## What never changes

- The [house rules](CONTRIBUTING.md#house-rules).
- Provenance. Every number carries its state, source, file, effective date and retrieved
  date. No number is shown without them, and no number is made up.
- No account, no ads, no tracking, no paywall. Not a lead-gen funnel.

A fork can change these. This project won't.

## Data corrections

1. Someone reports a wrong price with the wrong price form, with evidence.
2. A maintainer checks the number against the source file named on the card. The file
   name and its sha256 are in `data/drugs.json`.
3. If OpenBill read, joined or calculated it wrong, we fix the code, add a spot check to
   `tests/spotchecks.json` pinned to that source file, rebuild, and note the fix in
   [CHANGELOG.md](CHANGELOG.md).
4. If the source file itself is wrong, we don't change a filed number. The page shows what
   the file says. We note the problem on the issue and point to the publisher (CMS, FDA). If
   a value is unusable, we can leave the record out and say why; we never replace it with a
   number of our own.
5. Either way, the issue is closed with what we found.

## Becoming a maintainer

Contribute for a while: merged pull requests, careful reviews, spot checks verified against
source files, wrong-price reports triaged. Then a maintainer can invite you, and the project
owner agrees. A maintainer who is inactive for a year is moved to an emeritus list here and
is welcome back by asking.

## Forks

Forks are welcome; the code is [MIT licensed](LICENSE). Another country's data, another
audience, another design: go ahead. If your fork drops provenance or changes the house
rules, please give it a different name, so people can tell the two apart.
