import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  LocalOperationCancelledError,
  LocalOperationFailedError,
  LocalOperationUnknownError,
  type LocalOperationOptions,
} from "../../src/local-operation.js";
import { runCommands } from "../../src/lanes.js";

const execute = promisify(execFile);

type Operation = {
  digest: string;
  result: Promise<void>;
};

export function createControllerLocalExecutor(): typeof runCommands {
  const operations = new Map<string, Operation>();
  return async (cwd, commands, options: LocalOperationOptions): Promise<void> => {
    const key = JSON.stringify([
      options.runId,
      options.operationId,
      options.authorization?.path ?? "",
      options.authorization?.stopGeneration ?? 0,
    ]);
    const digest = JSON.stringify({ cwd, commands, candidate: options.candidate ?? null });
    const previous = operations.get(key);
    if (previous) {
      if (previous.digest !== digest)
        throw new LocalOperationUnknownError("Portable local operation identity changed.");
      return previous.result;
    }
    const result = (async () => {
      for (const command of commands) {
        if (!await options.isAuthorized())
          throw new LocalOperationCancelledError("Portable local operation was cancelled.");
        const [program, ...args] = command;
        if (!program) throw new LocalOperationFailedError("Portable local command is empty.");
        try {
          await execute(program, args, { cwd });
        } catch (error: unknown) {
          const code = typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
          throw new LocalOperationFailedError(
            `Portable local command failed (exit ${String(code ?? "unknown")}).`,
          );
        }
      }
    })();
    operations.set(key, { digest, result });
    return result;
  };
}
