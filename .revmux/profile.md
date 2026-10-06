# pi-plan-exec review profile

- Product: a Pi extension controlling local Markdown-plan and goal execution.
  It is a developer tool, not a network service. Failures can duplicate Git
  writers, overwrite work, lose recovery evidence, or mislead an operator.
- Project rules: `DEVELOPMENT.md`, `docs/architecture.md`,
  `docs/runtime-contracts.md`, `docs/guide.md`, `tsconfig.json`, `biome.json`.
  Verify claims against current implementation and package contracts when docs conflict.
- Languages: strict TypeScript/ESM, Node.js process/filesystem integration,
  shell-backed Git commands, Markdown instructions, optional terminal UI.

## Correctness and ownership bar

- Keep one authorized writer per execution target. Persist intent and immutable
  identity before dispatch; reconcile the same operation after a lost reply.
- Distinguish user stop intent, control acknowledgement, result state,
  resumability, verified progress, and identity-bound process retirement.
  Missing files, age, heartbeat, or a successful transport reply do not prove exit.
- Preserve CAS/lock/lease ordering, stop generations, explicit pauses, frozen
  checks, accepted-commit ancestry, and user work across restart or session replacement.
- Unknown/foreign ownership stays fenced. No implicit provider/model fallback,
  blind replay, manual child substitution, or weakened proof checks.
- UI, Fleet and pi-tasks are advisory projections. Their failure must not change
  execution authority or block recovery. Respect each extension's ownership.
- Validate external replies and persisted data at boundaries. Do not promote
  display telemetry into completion, exact usage, or retirement evidence.
- Keep the documented POSIX process-group containment limits honest.

## Implementation and evidence

- Prefer the smallest correct change following existing module boundaries.
  Flag concrete failure scenarios, not speculative abstractions or style preferences.
- Tests should exercise user-visible transitions, race/error paths and real
  integration boundaries. Mocks do not establish live-runtime compatibility.
- Checks: `npm run check`, `npm test`, `npm run test:runtime-smoke`,
  `npm run pack:dry`. npm 12.0.2 is the development toolchain.
- Biome owns lint/format policy; TypeScript owns strict/null/optional-field checks.
- Host SDK/TUI/TypeBox remain peers, not private runtime copies. Check packed
  consumers and independently installed provider compatibility.
- Docs and skills must agree with actual supported controls, upgrade requirements,
  safety limits and evidence. Do not present scripted model fixtures as live-LLM proof.
- Reviews do not mutate real run registries, install global packages, or publish.
  Releases follow the repository's tag-driven workflow after explicit authorization.
