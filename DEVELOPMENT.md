# Development

## Local setup

```bash
npm exec --yes --package=npm@12.0.2 -- npm ci
npm run test:all
pi install /absolute/path/to/pi-plan-exec
```

Reload Pi after changing the extension:

```text
/reload
```

Use npm 12.0.2. Strict execution installs released packages only; see
[runtime contracts](docs/runtime-contracts.md) before attempting an execution.

Tooling: TypeScript 7, Biome (lint and format, replacing ESLint), and Vitest.
`npm test` runs Vitest over `test/**/*.test.ts`. `test/index.test.ts` still runs
under `node:test` because its session-lifecycle mocks depend on node:test's
timer/mock semantics that Vitest does not reproduce yet; the script runs both
runners. `test/autonomous-runtime-smoke.mjs` stays a separate `node --test`
script (`npm run test:runtime-smoke`).

## Validation

```bash
npm run check
npm test
npm run test:runtime-smoke
npm run pack:dry
```

`npm run check` runs Biome and `tsc`; `npm run lint` and `npm run format` are
available for focused runs. `npm run test:all` is the local gate used by CI and
the release workflow.
`npm run pack:dry` checks the final npm tarball against a runtime-only allowlist;
the release workflow checks npm before it performs an actual publish.

## Release

Target package:

```text
@alexeiled/pi-plan-exec
```

Normal releases are tag-driven. Decide patch versus minor first, update
`package.json`, `package-lock.json`, and `CHANGELOG.md`, then commit the release
version before tagging:

```bash
npm run test:all
git commit -am "chore: release <version>"
git tag v<version>
git push origin main --follow-tags
```

Use `npm version patch` or `npm version minor` only when it is the command that
makes the intended version change; do not bump an already versioned release a
second time.

The release workflow runs only for pushed `v*` tags. It rejects a tag that does
not match `package.json` or is not on `main`, runs the validation gate, publishes
with npm provenance, and creates a GitHub Release.

### Trusted publishing

The workflow uses GitHub Actions OIDC, not `NPM_TOKEN`. It needs:

- a GitHub-hosted runner;
- `id-token: write` in `.github/workflows/release.yml`;
- an npm trusted publisher tied to `alexei-led/pi-plan-exec` and `release.yml`;
- the `repository.url` in `package.json` to exactly match the GitHub repository.

npm cannot configure a trusted publisher until the package already exists. The
initial release therefore needs one authenticated local publish, then a one-time
trust configuration. The exact bootstrap commands are supplied during release
setup; do not add an npm token to GitHub secrets.

After trusted publishing is configured, future releases must go through pushed
version tags. Do not run local `npm publish` again.
