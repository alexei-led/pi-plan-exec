import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, LockTimeoutError } from "../../src/registry-lock.js";
import { RunRegistry } from "../../src/registry.js";
import { DEFAULT_FROZEN_RUN_CONFIG } from "../../src/types.js";

const [mode, directory, argument] = process.argv.slice(2) as [string, string, string];
const queued: string[] = [];
let receiver: ((value: string) => void) | undefined;
process.on("message", (message: unknown) => {
  assert.equal(typeof message, "string");
  if (receiver) {
    const receive = receiver;
    receiver = undefined;
    receive(message as string);
  } else queued.push(message as string);
});
async function command(expected: string): Promise<void> {
  const received = queued.shift() ?? await new Promise<string>(resolve => { receiver = resolve; });
  assert.equal(received, expected);
}
function send(event: string, value?: unknown): void { process.send!({ event, value }); }

async function main(): Promise<void> {
  if (mode === "hold") {
    const lock = await acquireLock(directory);
    send("held");
    await command("release");
    await lock.release();
    send("released");
    await command("release-again");
    await lock.release();
    send("released-again");
    await command("quit");
  } else if (mode === "probe") {
    await assert.rejects(acquireLock(directory, 1), LockTimeoutError);
    send("contended");
  } else if (mode === "create") {
    const registry = new RunRegistry(directory);
    if (argument === "contender") {
      await assert.rejects(acquireLock(join(directory, "registry.lock"), 1), LockTimeoutError);
      send("contended");
    }
    const check = registry.assertExclusive.bind(registry);
    registry.assertExclusive = async run => {
      await check(run);
      send("checked");
      await command("publish");
    };
    try {
      const run = await registry.create({
        schemaVersion: 1, repositoryRoot: directory, planPath: join(directory, "plan.md"),
        planHash: "hash", worktreeCwd: directory, branch: "feature", defaultBranch: "main",
        status: "running", stage: "implementation", taskAttempts: {}, stageAttempts: {},
        reviewFindings: [], unresolvedFindings: [], config: DEFAULT_FROZEN_RUN_CONFIG,
      }, { exclusive: true });
      send("result", { created: true, id: run.id });
    } catch (error) {
      send("result", { created: false, error: String(error) });
    }
  } else if (mode === "update") {
    const registry = new RunRegistry(directory);
    const run = JSON.parse(await readFile(argument, "utf8"));
    send("ready");
    await command("update");
    const updated = await registry.updateIfCurrent({ ...run, branch: String(process.pid) }, run.updatedAt);
    send("result", { applied: updated.applied });
  } else throw new Error(`Unknown mode: ${mode}`);
  process.disconnect!();
}
main().catch(error => { console.error(error); process.exit(1); });
