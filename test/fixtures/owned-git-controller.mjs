import { appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [mode, root, registryDirectory, sessionId, statePath, bridgeMarkerPath, readyPath, executorEntryPath, value] = process.argv.slice(2);
if (!mode || !root || !registryDirectory || !sessionId || !statePath || !bridgeMarkerPath || !readyPath || !executorEntryPath || !value) {
  throw new Error("owned-git-controller requires mode, root, registry, session, state, marker, ready, executor entry, and value");
}

const controllerModule = await import(new URL("../../src/controller.ts", import.meta.url));
const bridgeModule = await import(new URL("../../src/bridge.ts", import.meta.url));
const lanesModule = await import(new URL("../../src/lanes.ts", import.meta.url));
const registryModule = await import(new URL("../../src/registry.ts", import.meta.url));
const { PlanExecController } = controllerModule.default ?? controllerModule;
const { bridgeRequestDigest } = bridgeModule.default ?? bridgeModule;
const { runCommands } = lanesModule.default ?? lanesModule;
const { RunRegistry } = registryModule.default ?? registryModule;

const command = async (program, args, cwd) => {
  try {
    const result = await execute(program, args, { cwd });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error;
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 1 };
  }
};

const ok = (data) => ({ success: true, data });
const bridge = {
  async capabilities() {
    return {
      protocolVersion: 2,
      healthy: true,
      workflowScriptSpawn: true,
      singleAgentSpawn: true,
      durableOperationLookup: true,
      processTerminalProofVersion: 1,
      executionLifetimeVersion: 1,
      executionLifetimeModes: ["unbounded", "bounded"],
      processTreeOwnership: { version: 1, scope: "owned-process-tree", escapedDescendants: "contained" },
    };
  },
  async spawn(operationId, params) {
    await appendFile(bridgeMarkerPath, `${JSON.stringify({ operationId, cwd: params.cwd, lifetime: params.executionLifetime })}\n`);
    return ok({ runId: operationId, requestDigest: bridgeRequestDigest(params), effectiveExecutionLifetime: params.executionLifetime });
  },
  async operation(operationId) { return ok({ state: "absent", operationId, replaySafe: true }); },
  async status(operationId) { return ok({ state: "absent", operationId, replaySafe: true }); },
  async result(operationId) { return ok({ state: "absent", operationId, replaySafe: true }); },
  async adopt(operationId) { return ok({ state: "absent", operationId, replaySafe: true }); },
  async stop(operationId) { return ok({ state: "stopped", operationId }); },
};
const fusion = {
  async start() { return ok({}); },
  async status() { return ok({}); },
  async result() { return ok({}); },
  async adopt() { return ok({}); },
  async cancel() { return ok({}); },
};

const registry = new RunRegistry(registryDirectory);
const executeLocalCommands = async (cwd, commands, options) => {
  if (commands.length) await appendFile(executorEntryPath, `${JSON.stringify({ operationId: options.operationId, commands })}\n`);
  return runCommands(cwd, commands, options);
};
const controller = new PlanExecController(registry, bridge, fusion, command, executeLocalCommands);
const writeState = async (run) => writeFile(statePath, JSON.stringify({ id: run.id, lane: run.lanePreparation?.cwd, status: run.status, stage: run.stage, outputPromotion: run.outputPromotion, archiveOperation: run.archiveOperation }));
await writeFile(readyPath, String(process.pid));

if (mode === "start") {
  const run = await controller.start({ cwd: root, planPath: value, useWorktree: true, sessionId });
  await writeState(run);
  await writeState(await controller.tick(run.id, sessionId));
} else if (mode === "tick") {
  const run = await controller.tick(value, sessionId);
  await writeState(run);
} else if (mode === "until-spawn") {
  for (;;) {
    const run = await controller.tick(value, sessionId);
    await writeState(run);
    if (existsSync(bridgeMarkerPath)) break;
    await delay(25);
  }
} else {
  throw new Error(`Unknown controller mode: ${mode}`);
}
