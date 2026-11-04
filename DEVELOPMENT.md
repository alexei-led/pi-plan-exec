# Development

## Setup

Development uses Node **24.15.0** and npm **12.0.2**. Runtime supports
Node >=22.19.0; npm 12's development requirement is higher. Darwin/Linux need
the platform C compiler for the Node-API kernel-lock binding.

```bash
npm exec --yes --package=npm@12.0.2 -- npm ci --ignore-scripts
npm run test:all
```

The released development stack is Pi/TUI 1.5.0, pi-subagents 0.84.0 and optional
Fusion 0.12.0. Use registry releases, not Git overrides. No Bridge/pi-tasks
dependency is needed. Host modules stay peers, never private runtime copies.

For local source development, load the checkout in a separate Pi session.
Restart after installed package changes; reload is for source/config only.
Read the [runtime contract](skills/exec-plan/references/runtime-contracts.md)
before executing or recovering native work.

## Checks

```bash
npm run check
npm test
npm run test:runtime-smoke
npm run test:native-contracts
npm run test:native-recovery
npm run test:parent-death
npm run test:packed-consumer
npm run pack:dry
```

check runs Biome and TypeScript. test runs Vitest plus the node:test
command/session file, whose timer/mocking semantics are intentional.
test:all runs the full relevant gates. Do not weaken per-test deadlines or infer
success from a command budget timeout. Git/process-heavy suites need bounded
worker fanout; retain full output and diagnose contention separately from defects.

pack:dry verifies the runtime-only manifest, host peers and relative Markdown
destinations against packed files—not documents merely present in the checkout.
Installed safety contracts live under the shipped skill references. Source-only
guides use versioned repository URLs from the installed README.

### Native versus normal-loader coverage

native-single-runtime tests cover exact request/source/agent/cwd/output identity,
sparse initial status, lost replies, missing delivered results, proof states,
foreign control and stop/dispatch order. Historical workflow tests preserve v1
decoding and old evidence semantics; they are not the new production launch path.

runtime-smoke launches real detached native singles with deterministic substituted
sessions. It verifies controller acceptance/review/fix/stats and output/proof
capture. This is lower-level integration, not a real model/normal-loader claim.

packed-consumer installs an actual tarball in a new isolated home with Pi1.5/
native0.84. Normal package loading, actual SDK sessions and a localhost scripted
OpenAI-compatible model exercise default readonly review, schema failures, plan/
goal/fix, controls, lost replies, provider recovery and child inertness. No user
credentials or live registry are read. Peer absence and capability ceilings are
tested explicitly. The Pi host family includes schema/telemetry; the old chord
package and codemode MCP preamble constant are not current API requirements.

A native completion watcher removes delivered result JSON. Tests therefore
validate retained exact status, process proof and unique bound output, while
rejecting any explicitly contradictory raw artifact/path. Never accept a
recent-output tail as the complete caller result.

Native recovery/parent-death gates are separate from pure tests. Pending or
writer-close-unverified proof retains its isolated evidence and reservation;
deleting it is not a valid way to make cleanup pass.

### Real Pi in agterm

Use only a new sandbox outside both checkouts, with its own HOME, agent directory,
native temp root, repository, registry and fake localhost model. Record installed
versions, loaded paths, source/lockfile hashes and terminal dimensions. No user
auth/settings/MCP/active-run data may be copied.

The real interactive validation must cover plan and goal completion, required
review/fix, pause/resume/cancel, reload/reopen, exact inspector selection,
narrow widths and light/dark themes. Save scoped terminal readbacks and palette
evidence. Display-only foreign-lease fixtures are screenshots, not execution
proof. A scripted model proves integration, not live-model quality.

Current evidence belongs in [UI validation](docs/ui-validation.md). Historical
screenshots and the selected-extension recovery harness do not certify the
current normal-loader stack.

## Release

Target: @alexeiled/pi-plan-exec. Releases are tag-driven through
.github/workflows/release.yml using GitHub OIDC; never publish around that
workflow with local npm credentials.

1. Work in an isolated branch/worktree.
2. Update package.json, package-lock.json and the committed changelog once.
3. Pass checks, full tests, native/recovery/packed and real-TUI validation.
4. Review the complete staged diff and release notes.
5. Commit, push and create a PR. Merge only after exact-commit gates pass.
6. Fetch the merged release commit and tag that exact commit.
7. Push the version tag to trigger the publisher.
8. Verify npm/GitHub versions, title, notes, tarball and provenance.

```bash
git push -u origin HEAD
gh pr create --repo alexei-led/pi-plan-exec --base main
git fetch origin main
git merge-base --is-ancestor <release-commit> origin/main
git tag v<version> <release-commit>
git push origin refs/tags/v<version>
```

Do not edit/push main directly, move a published tag, overwrite a package version
or bypass failed hooks. CI/release use the same pinned npm. Publication must
depend on native/packed validation for the exact tagged commit, not merely main
ancestry. Linux CI and local macOS validation are separate evidence.

The trusted publisher must remain tied to alexei-led/pi-plan-exec and release.yml,
with exact repository.url and id-token:write. Do not add NPM_TOKEN.
See the committed changelog for required upgrade actions and limits.

## Rollback preflight

Do not point an older executor at a registry containing native records/artifacts,
including terminal/abandonment history. Older cleanup can erase incompatible
evidence. The regression uses frozen unmodified 1.8.0 source at
bc5fb6ef800b6e88f3edeef542869bbd84a9ed3a; CI needs full Git history.

```bash
npm run check:rollback -- --registry /absolute/registry-or-consistent-backup
```

The check is read-only and refuses native records/artifacts, unreadable data,
symlinks and incomplete inspection. It never discovers a default live registry
or deletes evidence to permit downgrade. Quiesce owners first; a passing build
is not permission to discard reservations.
