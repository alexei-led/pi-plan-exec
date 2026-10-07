import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readSubagentArtifact } from '../../src/artifact.js';
import {
  PlanExecController as Controller,
  type NativeRuntime,
} from '../../src/controller.js';
import {
  executionRequestDigest,
  hasTerminalOwnershipProof,
} from '../../src/execution-contract.js';
import {
  type LegacyNativeBinding,
  type NativeObservation,
  type NativeOperationBinding,
  NativeRuntimeClient,
} from '../../src/native-runtime.js';
import type { RunRegistry } from '../../src/registry.js';
import { required } from '../../src/required.js';
import { parseReviewFindings } from '../../src/review.js';
import type { ActiveOperation, PlanExecRun } from '../../src/types.js';
import type { BridgeOperationOwner, BridgeResult } from './legacy-types.js';

type FixtureWorker = {
  capabilities?(): Promise<{ healthy: boolean }>;
  adopt?(id: string, dir?: string): Promise<BridgeResult>;
  spawn(
    id: string,
    params: Record<string, unknown>,
    owner?: BridgeOperationOwner,
  ): Promise<BridgeResult>;
  operation(id: string, owner?: BridgeOperationOwner): Promise<BridgeResult>;
  status(id: string, dir?: string): Promise<BridgeResult>;
  result(id: string, dir?: string): Promise<BridgeResult>;
  stop(id: string, dir?: string): Promise<BridgeResult>;
  cancelOperation?(
    id: string,
    owner?: BridgeOperationOwner,
  ): Promise<BridgeResult>;
};
const fixtureContracts = new WeakMap<
  FixtureWorker,
  Map<string, { params: Record<string, unknown>; digest: string }>
>();
type Args = ConstructorParameters<typeof Controller>;

/** Test-only adapter for existing domain fixtures, not a production backend.
 * Native RPC/identity/proof classification is exercised separately with the real
 * client. A fixture must still supply its exact retirement proof; missing or
 * contradictory proof is never upgraded to retirement here.
 */
export function nativeFixture(
  registry: RunRegistry,
  worker: FixtureWorker,
): NativeRuntime {
  let preparing: PlanExecRun;
  const preparer = new NativeRuntimeClient(
    { on: () => () => {}, emit() {} },
    registry,
    () =>
      ({
        sessionManager: {
          getSessionId: () =>
            preparing.lease?.sessionId ?? preparing.ownerSessionId ?? 'fixture',
          getSessionFile: () => undefined,
        },
      }) as ExtensionContext,
  );
  const contracts =
    fixtureContracts.get(worker) ??
    new Map<string, { params: Record<string, unknown>; digest: string }>();
  fixtureContracts.set(worker, contracts);
  async function load(runId: string, binding: LegacyNativeBinding) {
    const run = required(await registry.get(runId));
    const op = required(run.activeOperation ?? run.failedOperation);
    if (
      op.operationId !== binding.operationId ||
      op.requestDigest !== binding.requestDigest
    )
      throw new Error('Fixture native binding mismatch');
    return { run, op };
  }
  async function save(run: PlanExecRun, op: ActiveOperation) {
    const latest = required(await registry.get(run.id));
    if (latest.status === 'abandoned') return op;
    if (latest.activeOperation?.operationId !== op.operationId) return op;
    return required(
      (
        await registry.updateIfCurrent(
          {
            ...latest,
            ...(latest.failedOperation?.operationId === op.operationId &&
            latest.failedOperation.requestDigest === op.requestDigest
              ? { failedOperation: op }
              : {}),
            activeOperation: {
              ...op,
              ...(latest.activeOperation.stopRequested !== undefined
                ? { stopRequested: latest.activeOperation.stopRequested }
                : {}),
            },
          },
          latest.updatedAt,
        )
      ).run.activeOperation,
    );
  }
  async function observe(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const { run, op } = await load(runId, binding);
    if (op.launchFenced) return { state: 'retired', operation: op };
    if (!op.externalRunId) {
      if (op.native?.phase === 'prepared')
        return { state: 'prepared', operation: op };
      const contract = contracts.get(op.operationId);
      const lookup = await worker.operation(op.operationId, {
        kind: 'pi-plan-exec',
        runId,
        key: op.operationId,
        requestDigest: contract?.digest ?? binding.requestDigest,
      });
      if (
        lookup.success &&
        lookup.data.state === 'found' &&
        lookup.data.requestDigest === contract?.digest &&
        typeof lookup.data.runId === 'string'
      ) {
        await save(run, {
          ...op,
          externalRunId: lookup.data.runId,
          native: {
            ...required(op.native),
            phase: 'bound',
            childRunId: `${lookup.data.runId}-child`,
          },
        });
        return observe(runId, binding);
      }
      return {
        state: 'unknown',
        operation: op,
        reason: lookup.success
          ? String(
              lookup.data.text ??
                'No exact fixture native correlation; replay fenced.',
            )
          : lookup.error.message,
      };
    }
    const reply = await worker.status(op.externalRunId, op.asyncDir);
    if (!reply.success)
      return { state: 'unknown', operation: op, reason: reply.error.message };
    const contract = contracts.get(op.operationId);
    const retired = hasTerminalOwnershipProof(reply.data, op.externalRunId, {
      operationId: op.operationId,
      requestDigest: contract?.digest ?? binding.requestDigest,
    });
    const state =
      typeof reply.data.state === 'string' ? reply.data.state : 'unknown';
    const proof = retired
      ? {
          version: 1 as const,
          kind: 'workflow' as const,
          state: 'observed' as const,
          runId: op.externalRunId,
          dispatchClosed: true as const,
          observedAt: Date.now(),
          children: [],
        }
      : undefined;
    const operation = await save(run, {
      ...op,
      lastObservedState: state,
      ...(retired ? { processTreeExited: true } : {}),
      ...(op.native
        ? {
            native: {
              ...op.native,
              phase: retired ? 'retired' : 'bound',
              ...(proof
                ? { retirement: 'native-proof', terminalProof: proof }
                : {}),
            },
          }
        : {}),
    });
    return {
      status: Object.fromEntries(
        Object.entries(reply.data).filter(([key]) =>
          [
            'activity',
            'totalTokens',
            'totalCost',
            'terminationReason',
            'advisoryObservation',
            'text',
          ].includes(key),
        ),
      ),
      state: retired ? 'retired' : 'bound',
      operation,
      workflowState: state,
      ...(proof ? { proof } : {}),
      ...(typeof reply.data.text === 'string'
        ? { reason: reply.data.text }
        : {}),
    };
  }
  async function cancel(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const { run, op } = await load(runId, binding);
    if (op.native?.phase === 'prepared') {
      const operation = await save(run, {
        ...op,
        launchFenced: true,
        native: {
          ...op.native,
          phase: 'retired',
          retirement: 'local-not-started',
        },
      });
      return { state: 'retired', operation };
    }
    const observation = await observe(runId, binding);
    if (observation.state === 'retired') return observation;
    const current = observation.operation;
    if (
      !current.externalRunId ||
      current.stopDeliveredTo === current.externalRunId
    )
      return { ...observation, stopPending: true };
    const reply = await worker.stop(current.externalRunId, current.asyncDir);
    const delivered =
      reply.success &&
      reply.data.state === 'stopping' &&
      reply.data.runId === current.externalRunId;
    const updated = { ...current };
    if (delivered) {
      updated.stopDeliveredTo = current.externalRunId;
      delete updated.cancellationDeliveryError;
    } else
      updated.cancellationDeliveryError = {
        message: reply.success
          ? 'Malformed native stop reply.'
          : reply.error.message,
        observedAt: Date.now(),
        ...(!reply.success && reply.error.code
          ? { upstreamCode: reply.error.code }
          : {}),
      };
    return {
      ...observation,
      operation: await save(run, updated),
      stopPending: true,
    };
  }

  async function legacy(runId: string, binding: LegacyNativeBinding) {
    const { op } = await load(runId, binding);
    if (!op.externalRunId)
      return {
        operation: op,
        retired: false,
        reason:
          'Legacy identity remains fenced; no replay is authorized. Import an exact offline snapshot.',
      };
    const reply = await worker.status(op.externalRunId, op.asyncDir);
    return {
      operation: op,
      retired:
        reply.success &&
        Boolean(
          op.externalRunId &&
            hasTerminalOwnershipProof(
              reply.data,
              op.externalRunId,
              binding.requestDigest
                ? {
                    operationId: binding.operationId,
                    requestDigest: binding.requestDigest,
                  }
                : undefined,
            ),
        ),
      ...(reply.success
        ? { data: reply.data }
        : { reason: reply.error.message }),
    };
  }
  return {
    async available() {
      return (await worker.capabilities?.())?.healthy !== false;
    },
    async prepare(run, input) {
      preparing = run;
      const op = await preparer.prepare(run, input);
      const params = {
        agent: input.agent,
        task: input.task,
        cwd: input.cwd ?? run.worktreeCwd,
        context: 'fresh',
        mission: false,
        worktree: false,
        acceptance: false,
        executionLifetime:
          input.executionLifetime ?? run.config.executionLifetime,
        turnBudget: { maxTurns: input.maxTurns },
        ...(input.model ? { model: input.model } : {}),
      };
      contracts.set(op.operationId, {
        params,
        digest: executionRequestDigest(params),
      });
      return op;
    },
    async spawn(runId, binding) {
      const { run, op } = await load(runId, binding);
      if (op.native?.phase !== 'prepared') return observe(runId, binding);
      if (run.userStopped || !['running', 'starting'].includes(run.status))
        return cancel(runId, binding);
      await save(run, {
        ...op,
        native: { ...op.native, phase: 'dispatching' },
      });
      const contract = required(contracts.get(op.operationId));
      const reply = await worker.spawn(op.operationId, contract.params, {
        kind: 'pi-plan-exec',
        runId,
        key: op.operationId,
        requestDigest: contract.digest,
      });
      if (!reply.success || typeof reply.data.runId !== 'string')
        return {
          state: 'unknown',
          operation: op,
          reason: reply.success ? 'No fixture run ID' : reply.error.message,
          ...(!reply.success
            ? {
                launchError: {
                  code:
                    reply.error.upstreamCode ?? reply.error.code ?? 'transport',
                  message: reply.error.message,
                },
              }
            : {}),
        };
      const operation = await save(run, {
        ...op,
        externalRunId: reply.data.runId,
        ...(typeof reply.data.asyncDir === 'string'
          ? { asyncDir: reply.data.asyncDir }
          : {}),
        native: {
          ...op.native,
          phase: 'bound',
          childRunId: `${reply.data.runId}-child`,
        },
      });
      return { state: 'bound', operation };
    },
    operation: observe,
    async result(runId, binding) {
      const observation = await observe(runId, binding);
      if (observation.state !== 'retired') return observation;
      const op = observation.operation;
      const reply = await worker.result(
        required(op.externalRunId),
        op.asyncDir,
      );
      if (!reply.success)
        return { ...observation, reason: reply.error.message };
      try {
        let output = await readSubagentArtifact(
          typeof reply.data.resultPath === 'string'
            ? reply.data.resultPath
            : undefined,
          op.asyncDir,
          {
            runId: required(op.externalRunId),
            successful: op.kind === 'review',
          },
        );
        if (
          !['complete', 'completed', 'done'].includes(
            observation.workflowState ?? '',
          )
        )
          return {
            ...observation,
            failureOutput: output,
            reason: `Fixture child ended as ${observation.workflowState}.`,
          };
        if (op.kind === 'review') {
          try {
            const findings = parseReviewFindings(output).map(
              ({ severity, summary, evidence, suggestion }) => ({
                severity,
                summary,
                evidence,
                suggestion,
              }),
            );
            output = JSON.stringify({
              schemaVersion: 1,
              reviewedCommit: op.reviewedCommit,
              findings,
            });
          } catch {
            /* Deliberately malformed fixture reports must reach semantic validation. */
          }
        }
        return {
          ...observation,
          result: {
            runId: required(op.externalRunId),
            childRunId: required(op.native?.childRunId),
            key: 'main',
            outputPath: required(op.native?.outputPath),
            output,
            envelope: reply.data,
          },
        };
      } catch (error) {
        return { ...observation, reason: String(error) };
      }
    },
    cancelOperation: cancel,
    observeAbandoned: observe,
    stopAbandoned: cancel,
    observeLegacy: legacy,
    async resultLegacy(runId, binding) {
      const observed = await legacy(runId, binding);
      if (!observed.operation.externalRunId || !observed.retired)
        return observed;
      const reply = await worker.result(
        observed.operation.externalRunId,
        observed.operation.asyncDir,
      );
      return reply.success
        ? {
            ...observed,
            data: {
              ...('data' in observed ? observed.data : {}),
              ...reply.data,
            },
          }
        : { ...observed, reason: reply.error.message };
    },
    async stopLegacy(runId, binding) {
      const observed = await legacy(runId, binding);
      if (observed.retired || !observed.operation.externalRunId)
        return observed;
      const reply = await worker.stop(
        observed.operation.externalRunId,
        observed.operation.asyncDir,
      );
      return {
        ...observed,
        reason: reply.success
          ? 'Stop delivered; retirement remains unconfirmed.'
          : reply.error.message,
      };
    },
  };
}

export class PlanExecController extends Controller {
  constructor(
    registry: Args[0],
    runtime: NativeRuntime | FixtureWorker,
    fusion: Args[2],
    command: Args[3],
    local?: Args[4],
  ) {
    super(
      registry,
      'prepare' in runtime ? runtime : nativeFixture(registry, runtime),
      fusion,
      command,
      local,
    );
  }
}
