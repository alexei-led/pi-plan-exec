# Development

## Local setup

```bash
npm exec --yes --package=npm@12.0.2 -- npm ci
npm run test:all
pi install /absolute/path/to/pi-plan-exec
```

Restart Pi after upgrading installed packages. Reload is for local extension
source/config changes, not mixed loaded/installed package versions:


```text
/reload
```

Use npm 12.0.2. The default subagent backend uses released packages; see
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
npm run test:native-recovery
npm run test:parent-death
npm run test:packed-consumer
npm run pack:dry
```

`npm run check` runs Biome and `tsc`; `npm run lint` and `npm run format` are
available for focused runs. `npm run test:all` runs all local unit/native/recovery/parent-death/packed gates
and packaging checks. CI also runs bounded Ubuntu native gate jobs and retains
logs plus unresolved fixture metadata. Linux CI results are distinct from local
Darwin results; wiring a job is not evidence that it ran.
`npm run pack:dry` rejects private host SDK/TUI/TypeBox dependencies and checks
the final npm tarball against a runtime-only allowlist. Host packages stay peers,
never runtime copies: Pi core uses `^1.0.4`; the other host aliases use `"*"`.
Development dependencies use the tested host range. The release workflow checks npm before
it performs an actual publish. The real Pi RPC smoke test loads the package
root and checks command registration without host-module warnings.

The tested baseline and deferred integration work are recorded in the
[upstream audit](docs/upstream-audit.md).

## Native and packed integration

`test:runtime-smoke` launches real 0.76.1 detached workers with deterministic
scripted sessions, verifying controller checks, typed review/fix/stats and bound
artifacts. No removed package is loaded. `test:native-recovery` uses fresh OS
hosts to prove keyed-workflow request correlation and exact child retirement;
direct-leaf missing correlation remains an explicit negative case.

`test:packed-consumer` creates a real npm tarball and a dedicated temporary
consumer, using npm 12.0.2 to install only Pi 1.0.4, pi-subagents 0.76.1 and the
package. It asserts that neither removed package resolves from the consumer or
extension. A localhost OpenAI-compatible scripted model uses no user credentials
or paid API. Pi loads packages and observer extensions normally, without
`--no-extensions` or replacement production clients. Child-mode loading must not
register `/exec`/`/goal` or take parent leases. Tests cover plan/goal, default
readonly reviewer, clean/findings output, malformed/missing/wrong-commit refusal,
a dropped public RPC reply and force-stop/restart.

The isolated preload only sets the temporary home and injects a single dropped
public event response; it does not patch installed runtime code. Failed evidence
is retained with its path. If an early stop yields `writer-close-unverified`, the
passing safety case retains the isolated ownership record/workspace instead of
pretending exit and deleting it. Do not clean unknown ownership merely to make
tests leave an empty directory.

The normal loader exposed 0.76.1's structured-output-only/file-only settlement
failure. Schema requests now keep the bound output path but use supported inline
settlement; marker requests remain file-only. The smoke checks actual persisted
JSON and exact native proof, not a model summary.

For optional visible manual probes, use
`node test/recovery-agterm.mjs <new-sandbox> <runtime-root> --server-only`.
The runtime root is a local checkout with released native/Pi dependencies, not a
Bridge checkout. `/fixture-seed [lost-reply]` creates only isolated native intent
and closed schema-7 fixture data. It never constructs a removed journal service.
This selected-extension manual harness is not the packed normal-loader gate.

## Progress strip validation

The chosen UI and native screenshots are in [UI validation](docs/ui-validation.md).
`test/run-view.test.ts` covers column widths, status precedence, colors and display
preferences. Lifecycle tests cover hide/clear across reload and late projection.
The recovery fixture uses a real Pi TUI, released native subagents and a local
scripted model. `test/fixtures/progress-ui.ts` adds display-only states inside
that explicitly isolated sandbox; its foreign lease prevents worker dispatch.
It is never shipped in the npm package.

## Release

Target package:

```text
@alexeiled/pi-plan-exec
```

Normal releases are tag-driven. Choose patch, minor or major from the compatibility
impact, update
`package.json`, `package-lock.json`, and `CHANGELOG.md`, then commit the release
version before tagging:

```bash
npm run test:all
git commit -am "chore: release <version>"
git tag v<version>
git push origin main --follow-tags
```

Use `npm version patch`, `npm version minor` or `npm version major` only when it is the command that
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


## Rollback preflight

Never point an older executor directly at a registry containing native data.
The frozen 1.8.0 parser accepts the extra native service data; its reservation
check can still block a competing owner, but that is not format rejection.
Its explicit cleanup can delete native terminal artifacts or unreadable owner
records. `test/rollback-preflight.test.ts` demonstrates those actual paths using
unmodified source pinned to `bc5fb6ef800b6e88f3edeef542869bbd84a9ed3a` in a disposable fixture.

Before any supported rollback, quiesce writers and use the new read-only check
against an explicitly selected registry/consistent backup:

```bash
npm run check:rollback -- --registry /absolute/registry-directory
```

It refuses native records, retained native artifact directories, terminal and
abandonment history, unreadable JSON, symlinks and incomplete inspection. It never
opens a default live registry or deletes evidence to make rollback pass. Running
old code directly bypasses this check and remains unsafe.
