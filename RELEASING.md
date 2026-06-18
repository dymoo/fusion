# Releasing `@dymoo/fusion`

Releases publish to npm via **GitHub OIDC trusted publishing** — no `NPM_TOKEN` is
stored anywhere. The workflow is [`.github/workflows/release.yml`](.github/workflows/release.yml)
(`id-token: write`, Node 24, `npm publish --access public --ignore-scripts`).

## One-time bootstrap (first publish of a brand-new package)

npm only lets you configure a trusted publisher **after** the package exists, so the
very first version must be published manually. Do this once:

```bash
npm login                       # your account in the @dymoo org
cd ~/git/fusion
pnpm install
pnpm run build
npm publish --access public     # --access public is required for a scoped package's first publish
```

Then on npmjs.com configure trusted publishing so all future releases are tokenless:

- **npmjs.com → `@dymoo/fusion` → Settings → "Trusted Publisher" → GitHub Actions**, and enter:
  - Organization / owner: `dymoo`
  - Repository: `fusion`
  - Workflow filename: `release.yml`
  - Environment: _(leave blank — `release.yml` does not use a GitHub Environment)_

That's it — the package is live and CI can publish from here on.

## Ongoing releases (every version after the bootstrap)

```bash
# 1. bump the version in package.json (e.g. 0.1.0 -> 0.2.0)
# 2. commit + tag + push
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main --tags

# 3. create the GitHub Release — this triggers release.yml
gh release create v0.2.0 --title v0.2.0 --notes "…"
```

`release.yml` then runs `check-all` + tests + build (the `verify` job) and, on success,
publishes via OIDC (the `publish-npm` job). Provenance attestations are generated
automatically — no `--provenance` flag needed.

## Requirements / notes

- OIDC trusted publishing needs **npm ≥ 11.5.1** and **Node ≥ 22.14** — the CI runner
  uses Node 24, so this is handled. (Your local npm only needs to be recent enough for
  the one manual bootstrap publish; it uses login auth, not OIDC.)
- The published tarball is the runtime artifact only (`dist` minus tests/sourcemaps,
  plus `config.example.yaml`, `README.md`, `LICENSE`); CI's "npm package smoke install"
  job installs the packed tarball each run to catch packaging regressions.
- Never add an `NPM_TOKEN` secret — trusted publishing is intentionally tokenless.
