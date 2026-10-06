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
npm run pack:dry
```

`npm run check` runs Biome and `tsc`; `npm run lint` and `npm run format` are
available for focused runs. `npm run test:all` is the local gate used by CI and
the release workflow.
`npm run pack:dry` rejects private host SDK/TUI/TypeBox dependencies and checks
the final npm tarball against a runtime-only allowlist. Host packages stay peers,
never runtime copies: Pi core uses `^1.0.4`; the other host aliases use `"*"`.
Development dependencies use the tested host range. The release workflow checks npm before
it performs an actual publish. The real Pi RPC smoke test loads the package
root and checks command registration without host-module warnings.

The tested baseline and deferred integration work are recorded in the
[upstream audit](docs/upstream-audit.md).

## Visible recovery integration

Run `node test/recovery-agterm.mjs <new-sandbox> <bridge-checkout> --server-only`
in a dedicated agterm session. The sandbox must not exist, its parent must
exist, and its canonical path must be outside both checkouts. It creates two
isolated repositories and a local
deterministic HTTP model. Launch the actual Pi CLI in a second agterm session
with `session new --command`, using the sandbox's `home`, `agent`, and temporary
directory. Load only the released pi-subagents extension, local Bridge,
local plan-exec, and `test/fixtures/recovery-host.ts`; disable discovered
extensions/context files. Set `PLAN_EXEC_RECOVERY_SANDBOX` and
`PLAN_EXEC_RECOVERY_BRIDGE` to those exact paths.

Run `/fixture-seed` once. It sends a genuine removed-field request through
Bridge to the native validator, tests replay, and creates a synthetic legacy
dispatching row. Close that Pi host, then start a new one against the same
sandbox. Use `/exec status` and the IDs in `ids.json` for status/resume.
The rejected run must complete one task with one successful worker dispatch;
the legacy row must stay unknown with no child. `/fixture-proof` asserts both
and writes `proof.json`. The expected two native spawn requests are one
pre-launch rejection and one successful child workflow, not two workers.

The model's tool call modifies only the fixture repository. No credentials are
copied, no global package is changed, and no real run/journal is used. Retain
the sandbox and agterm IDs as local evidence; do not publish private paths.

## Progress strip validation

The chosen UI and native screenshots are in [UI validation](docs/ui-validation.md).
`test/run-view.test.ts` covers column widths, status precedence, colors and display
preferences. Lifecycle tests cover hide/clear across reload and late projection.
The recovery fixture uses a real Pi TUI, released Bridge/subagents and a local
scripted model. `test/fixtures/progress-ui.ts` adds display-only states inside
that explicitly isolated sandbox; its foreign lease prevents worker dispatch.
It is never shipped in the npm package.

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
