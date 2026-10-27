# Tensorust Cargo Check

A GitHub Action for Rust projects. Every time a pull request changes a `Cargo.toml` or `Cargo.lock`, it posts one comment (and keeps editing that same comment) that tells you:

- **Security advisories** for the exact locked versions, from [OSV](https://osv.dev/), which includes the RustSec database that `cargo audit` uses, with the smallest upgrade that fixes each one
- **Unmaintained and unsound notices** from RustSec, kept apart from real vulnerabilities
- **Yanked versions** sitting in your lock file
- **Crates a breaking release behind** (1.x when 2.x is out, 0.3 when 0.4 is out)
- **Licenses**, with copyleft (GPL, LGPL, MPL, AGPL...) and missing licenses flagged
- **The newest MSRV in the tree**: the oldest Rust that can still build your project
- **New dependencies added by the PR**: direct ones added to `Cargo.toml`, and every package new to `Cargo.lock`

Each crate and advisory links to a page that explains it: `tensorust.com/rust/advisories/<id>/`, `tensorust.com/crates/<crate>/` and `tensorust.com/rust/features/<crate>/`.

No install step, no Rust toolchain, no `cargo` run: it reads the files through the GitHub API and finishes in seconds.

## Quick start

`.github/workflows/cargo-check.yml`:

```yaml
name: Cargo Check
on:
  pull_request:
    paths: ['**/Cargo.toml', '**/Cargo.lock']

permissions:
  contents: read
  pull-requests: write

jobs:
  cargo-check:
    runs-on: ubuntu-latest
    steps:
      - uses: Mattbusel/tensorust-cargo-check@v1
```

That is all. Open a PR that bumps a dependency and the comment appears.

## Fail the check on advisories

```yaml
      - uses: Mattbusel/tensorust-cargo-check@v1
        with:
          fail-on: advisories
```

`fail-on` takes any of `advisories`, `yanked`, `unmaintained`, `copyleft`, comma separated. By default the check never fails; it only reports.

## Fix it for me: weekly upgrade pull requests

Turn on `fix: true` on a schedule and the action applies the smallest upgrade that clears each security advisory and yanked version, runs your tests, and opens one pull request for you to approve. It only touches `Cargo.lock` and only moves inside your Cargo.toml requirements; anything that needs a breaking bump is listed for a person. If your tests fail, the pull request opens as a draft with the output.

```yaml
name: Dependency fixes
on:
  schedule: [{ cron: '17 6 * * 1' }]
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Mattbusel/tensorust-cargo-check@v1
        with:
          fix: true
          test-command: cargo test --all-features
```

Free on public repos; private repos use the same $9 a month license key.

## Private repositories

Free on every public repo. A private repo needs a license key: **$9 a month per repo**, from [shop.tensorust.com/dev/cargo-check](https://shop.tensorust.com/dev/cargo-check). Store it as a repository secret and pass it in:

```yaml
      - uses: Mattbusel/tensorust-cargo-check@v1
        with:
          license-key: ${{ secrets.TENSORUST_CARGO_CHECK_KEY }}
```

Without a key, a private-repo run still passes. It posts one line saying how to turn the report on, and nothing else.

## More examples

A workspace with its lock file somewhere other than the root:

```yaml
      - uses: Mattbusel/tensorust-cargo-check@v1
        with:
          lockfile: backend/Cargo.lock
```

A nightly audit of `main` (no PR, so the report goes to the job summary):

```yaml
on:
  schedule: [{ cron: '0 6 * * *' }]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Mattbusel/tensorust-cargo-check@v1
        with:
          fail-on: advisories,yanked
```

Use the result in a later step:

```yaml
      - id: cc
        uses: Mattbusel/tensorust-cargo-check@v1
      - if: steps.cc.outputs.advisories != '0'
        run: echo "Advisories found: ${{ steps.cc.outputs.summary }}"
```

## Inputs

| Input | Default | What it does |
|---|---|---|
| `github-token` | `${{ github.token }}` | Reads the PR and posts the comment. Needs `pull-requests: write`. |
| `fail-on` | (empty) | Fail on any of `advisories`, `yanked`, `unmaintained`, `copyleft`. |
| `license-key` | (empty) | Only for private repos. |
| `lockfile` | auto | Every `Cargo.lock` the PR changes, plus the nearest one above each changed `Cargo.toml`. |
| `max-api-calls` | `60` | Licenses for the 1,000 most-used crates come from a table we publish; others cost one crates.io API call each, one a second as crates.io asks. |
| `comment` | `true` | `false` writes only the job summary. |
| `fix` | `false` | On scheduled or manual runs: upgrade vulnerable or yanked crates inside your requirements, test, open one pull request. |
| `test-command` | `cargo test` | Command fix mode runs to test the upgrades. |

## Outputs

`advisories`, `yanked`, `behind`, `new-dependencies` (counts) and `summary` (one line).

## How it decides

- **Locked versions** come from `Cargo.lock` (every lock file version). A library with no lock file is still checked: each `Cargo.toml` requirement is resolved to the version Cargo would pick today, with Cargo's caret, tilde, wildcard and comparison rules.
- **Advisories**: one OSV `querybatch` call with the exact versions, then the advisory details. A GitHub advisory that duplicates a RustSec one is shown once.
- **Yanked, newest version and MSRV** (`rust-version`) come from the crates.io sparse index.
- **"A breaking release behind"** follows Cargo's own compatibility rule: a different major version, or a different minor while the major is 0.
- **New dependencies**: packages in the PR's `Cargo.lock` whose name is not in the base branch's lock, plus dependencies added to any changed `Cargo.toml`.

Pull requests from forks get a read-only token from GitHub, so the comment cannot be posted there. The full report still goes to the job summary.

## Privacy

Only crate names and versions leave the runner: to `index.crates.io`, `crates.io` and `api.osv.dev`. For private repos, the license key and the repo name go to `shop.tensorust.com`, which answers valid or invalid and stores nothing. Your code never leaves GitHub.

## Also from Tensorust

- [Cargo.toml checker](https://tensorust.com/tools/cargo-toml-checker/): the same report in your browser, paste and go
- [Every RustSec advisory](https://tensorust.com/rust/advisories/), explained with the exact fix
- [Real crate downloads](https://tensorust.com/crates/), with release-day bot traffic taken out

## Development

```sh
npm install
npm test          # runs against fixture Cargo.lock files with recorded crates.io and OSV answers, no network
npm run build     # bundles src/ into dist/index.js with ncc
node scripts/record-fixtures.mjs   # re-record the network answers
```

MIT licensed. Made by [Tensorust](https://tensorust.com).
