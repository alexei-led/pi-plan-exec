# pi-plan-exec

<!-- markdownlint-disable MD013 -->

[![npm version](https://img.shields.io/npm/v/%40alexeiled%2Fpi-plan-exec?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@alexeiled/pi-plan-exec)
[![CI](https://img.shields.io/github/actions/workflow/status/alexei-led/pi-plan-exec/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/alexei-led/pi-plan-exec/actions/workflows/ci.yml?query=branch%3Amain)
[![node](https://img.shields.io/badge/node-%3E%3D22.19.0-5fa04e?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

Reliable, resumable ralphex-style plan execution for Pi.

> Experimental. Use a disposable worktree until this package has seen more live
> plan runs. The controller executes ordered tasks and review/fix stages through
> `pi-subagents-bridge` and `pi-fusion`.

The target design is in `docs/plans/2026-07-12-pi-plan-exec-design.md`.

## Install

```bash
pi install npm:pi-subagents
pi install npm:@tintinweb/pi-tasks
pi install npm:@alexeiled/pi-subagents-bridge
pi install npm:@alexeiled/pi-fusion
pi install npm:@alexeiled/pi-plan-exec
```

Reload Pi after installation.

## Runtime dependencies

Install compatible Pi packages before loading this extension:

- `pi-subagents` `0.34.0+`
- `@alexeiled/pi-subagents-bridge` `0.1.6+`
- `@alexeiled/pi-fusion` `0.5.1+`
- `@tintinweb/pi-tasks` `0.7.1+`

`pi-plan-exec` uses built-in `worker` and `reviewer` agents. It does not depend on
cc-thingz agents.

## Local test setup

Run the local sources together:

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-context-files \
  -e /path/to/pi-subagents/src/extension/index.ts \
  -e /path/to/pi-subagents-bridge/src/index.ts \
  -e /path/to/pi-fusion/src/index.ts \
  -e /path/to/pi-plan-exec/src/index.ts
```

Then, from an interactive Git repository session:

```text
/exec docs/plans/20260712-example.md
```

`/exec` always asks whether to use an isolated worktree. Plans must use ordered
`### Task N:` or `### Iteration N:` sections with checkbox items.

## Commands

```text
/exec <plan>
/exec runs
/exec status <run-id>
/exec pause <run-id>
/exec resume <run-id>
/exec adopt <run-id>
/exec cancel <run-id>
```

## Behavior

- Git only.
- Execution worktrees live under `~/.pi/plan-exec/worktrees/`, outside the source repo.
- Global run records live under `~/.pi/plan-exec/runs/`; they are the cross-session authority.
- pi-tasks is a session-scoped projection. It uses the installed `TaskStore` format and locking.
- Every worker/reviewer/fixer has fresh context.
- The plan's checkboxes decide implementation completion, not worker prose.
- Comprehensive, smells, Fusion, and critical review stages use `NO_FINDINGS` or
  `FINDING: CRITICAL|MAJOR|MINOR | ...` output contracts.
- Known findings that survive configured review caps produce `completed_with_findings`.
- Finalization, stats, and archival are best effort. The worktree is preserved.

## Development

```bash
npm run test:all
npm run publish:dry
```

See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the GitHub Actions and npm trusted
publishing release process.
