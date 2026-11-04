# Runtime contracts

## Supported stack

Use unmodified Pi **1.5.0** (`^1.5.0`) and pi-subagents **0.84.0**
(`>=0.84.0 <0.85.0`). Install them as independent Pi packages. Bridge,
pi-tasks and cc-thingz are not required. Optional Fusion 0.12.0 and Revmux remain
capability-gated: version numbers and ordinary successful panels do not prove
strict review compatibility.

Runtime requirements: Node >=22.19.0, Git, Darwin or Linux, and the platform C
compiler (`/usr/bin/clang` or `/usr/bin/cc`) for the small Node-API kernel-lock
binding. A worktree is isolation from another checkout, not a security sandbox.

Before upgrading, quiesce controllers and workers with their original runtime,
back up the registry and retained evidence, then restart all owning Pi sessions.
Do not mix old/new controllers against the same registry. Reload is for local
source/config changes, not installed dependency upgrades.

## Direct-single protocol, version 2

New implementation, review, fix and statistics operations use one direct public
`subagents:rpc:v1` async single. They contain `agent` and `task`, not a workflow
script. Native `mode:single` is excluded from workflow auto-resume; this avoids
the new-root workflow replay introduced in native 0.82 without changing global
`autoResume`. No effective-policy assertion is inferred from a config file.

The registry is the only dispatch ledger. Before dispatch it persists:

- logical operation, task/review/candidate and execution/stop generations;
- owner Pi UUID, native transcript identity, exact RPC UUID and immutable request;
- canonical authorized cwd, unique absolute caller-bound output, requested limits;
- adapter version and request digest; resolved admission identity is saved at dispatch.

Phases remain `prepared -> dispatching -> bound -> retired`. The same stable
record lock covers the final CAS, fsynced dispatch intent and synchronous event
emission. It is released before awaiting the RPC reply. Cancellation/abandonment
therefore serializes with dispatch rather than racing its final unlocked read.

Native spawn is not idempotent. A timeout never authorizes another spawn.
Recover a lost reply through exact `rpc-spawn-<saved-request-uuid>` status or a
correlated started/completion event. Bind structured run/tool identity and
independently validate the source session, cwd, contract and sole step. Missing,
expired, ambiguous or contradictory correlation remains unknown and fenced.

Pi UUIDs key capability ceilings and preflight parent identity. Native
transcript-path identity remains authoritative for native observation/control.
A registry lease takeover cannot impersonate the original native session.
Readable foreign status never grants stop/resume authority.

## Admission and owned reviewer

Only still-prepared operations enter the lazy public preflight. It receives the
exact saved child literal, current model/scope, current project trust, MCP host
and UUID-keyed capability ceiling. Missing selected skills, denied tools/models,
invalid agents and configured collisions refuse before emission. Session, trust,
registration and authority are rechecked after awaits and immediately before emit.

The default required `plan-exec-reviewer` is registered through public runtime
agent events. It has only read/grep/find/ls and no pinned model. Native preflight
still cannot discover runtime-only definitions, so only this successfully
registered, undisposed, no-skills role may use the narrow missing-agent exception.
Suggestion text is tolerated; disabled roles, invalid configuration, warnings,
missing skills, ceilings and collisions are not exempted. Explicit configured
agents/models are never silently replaced.

The resolved canonical agent is saved by dispatch admission and must match
successful native status/results, including when the request used an alias.

## Retirement and output

A terminal-looking status or completion message is not retirement. New singles
require the published observed process proof for the exact native run and runner
instance, including observed runner closure. Pending, unknown, mismatched or
standalone not-started proof cannot release ownership. PID disappearance, a
stop receipt, output-file existence and elapsed time are not substitutes.

Initial native status can lack cwd/contract details while its runner starts.
Exact run/session/tool identity may bind it, but incomplete projection cannot
retire it or produce output acceptance.

All new output uses file-only settlement and a unique private run-owned path.
Schema settlement must agree with the bound JSON. Symlinked, oversized, missing
or contradictory artifacts cannot pass. Native completion delivery deletes its
transient result JSON: validated retained single status, exact admitted agent,
successful sole step, independent runner proof and caller-bound output remain
the settlement contract. A supplied raw result is additionally checked; explicit
path or payload contradictions refuse. No truncated recent-output tail is used.

The controller copies validated output/proof under the owning run through the
authorized record-lock seam before acceptance. Failed-child text is diagnostic
only. Required review binds the exact candidate commit:

```json
{"schemaVersion":1,"reviewedCommit":"<full commit>","findings":[]}
```

Findings require CRITICAL/MAJOR/MINOR, summary, evidence and suggestion.
Missing/malformed/wrong-commit reports fail closed. Git ancestry, committed plan
checkboxes, frozen checks, clean-tree state and reviewed/verified commits remain
controller-owned gates. A worker marker or workflow success is not completion.

Native retries/compaction can continue or serially recreate an AgentSession
within one managed leaf. This is not a fresh plan-exec operation. The native
run's retirement barrier remains required. No arbitrary escaped-descendant
containment or one-factory-creation guarantee is claimed.

## Limits and presentation truth

Unbounded means no plan-exec wall-clock deadline; native single-agent/config
defaults still apply (normally 30 minutes). Bounded requests pass an explicit
positive timeout. Observed limits are shown separately. Requested worker,
reviewer and statistics maxTurns are not enforced by native RPC.

Goal maxTaskIterations is an implementation-turn budget, not an ordinary plan
retry cap. taskRetries, reviewIterations and fusionIterations are deprecated
diagnostic settings: accepted for existing configuration, not scheduling limits.
Local bootstrap/checks retain their unbounded user-stoppable owned POSIX runner;
Pi exec improvements do not replace its durable process retirement.

Fleet/background-work and activity observations are advisory. Paused cleanup
stays active until retirement. A live display requires this session's matching
lease and a recent successful local observation; a pending/stale poll becomes a
Snapshot. Polling is not proof of useful worker progress. Native jobs-changed
events are refresh hints, with periodic reconciliation retained.

The inspector uses native keyboard navigation, exact-ID actions and normal
confirmation guards. Hide/unhide changes visibility only and preserves selection.
Requested and reported model identities are distinct. Native usage is not proof
of provider billing; unavailable metrics are not zero. Native completion can
start a parent model turn; those turns are outside managed-child usage. A
notification must not start replacement work or edit the managed checkout.

A final admission/session refusal before emission can conservatively retain a
`dispatching` intent. Treat it as reserved uncertainty, not permission to delete
evidence or retry under a new identity.

## Historical operations and recovery

Version-1 workflow records keep their original requests, digests and decoder.
The new production adapter refuses new dispatch or automatic in-place
continuation of unresolved historical workflows; old root proof does not attest
absence of an automatically resumed successor, including for retired failed or
stopped roots. Only completed historical operations are exempt. Preserve their reservations and
use their original runtime to quiesce, or explicitly approve local-only isolated
recovery. Never relabel old intent as version 2 or start another run over unknown
ownership. Exact known targets retain inspection/best-effort control; missing
identity remains fenced.

Older Bridge data is read-only history, not a new backend. Bound IDs need no
journal. Unbound import requires an explicitly supplied consistent offline
schema-7 SQLite snapshot. Import preserves original identity, stop generations
and abandonment; absence/mapping/receipts are not non-start or replay authority.
Never copy only the main file of a live WAL database.

Pause is resumable. Cancel is final and dismisses display immediately, while
cleanup continues. Force-stop is irreversible management abandonment, not proof
of worker exit; unknown checkout ownership remains reserved. Stop delivery and
retirement are separate, and forced abandonment does not promise automatic
stop retries after management ends.

## Optional backends and forward compatibility

Fusion and Revmux are explicit selections with no implicit fallback. They must
advertise/meet their durable lookup, lifetime and owned-process proof contracts.
Released Fusion 0.12.0 ordinary operation does not establish strict compatibility.
Released Revmux 0.2.7 lacks the required lifecycle adapter. Refusal is intentional.

The next subagents 0.x minor can break these contracts. Test it before widening
the peer range. Pi 1.5 itself includes JSON Schema validation changes despite
being a minor; types and SemVer alone do not certify runtime behavior. Keep host
SDK/TUI/schema modules host-provided and test normal bundled loading.

## Verification boundary

Unit/session tests exercise CAS, generations, policy, exact artifacts and UI.
Native integration covers real detached execution/recovery; packed-consumer
tests load an actual tarball and unmodified Pi/native packages with a localhost
scripted model. Agterm validation exercises the real interactive Pi UI in a
separate home/registry. Scripted models prove deterministic integration, not
live-model performance. Record exact versions, commands and retained evidence;
a timeout or unknown retirement is not a passing gate.
