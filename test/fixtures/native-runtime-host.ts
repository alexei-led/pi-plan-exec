import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RPC_REPLY_PREFIX = 'subagents:rpc:v1:reply:';
const RPC_REQUEST_EVENT = 'subagents:rpc:v1:request';
let lastChildSessionModule: ChildSessionModule | undefined;

type EventHandler = (payload: unknown) => void;
type RpcMethod = 'ping' | 'status' | 'spawn' | 'stop';

type RpcResult = {
  requestId: string;
  delivered: boolean;
  reply?: unknown;
};

type NativeExecutor = {
  executePublic: (...args: unknown[]) => Promise<unknown>;
};

type NativeRpcRegistration = {
  dispose(): void;
};

type NativeEventBus = {
  on(name: string, handler: EventHandler): () => void;
  emit(name: string, payload: unknown): void;
};

type NativeState = {
  baseCwd: string;
  currentSessionId: string;
  asyncJobs: Map<string, unknown>;
  foregroundControls: Map<string, unknown>;
  lastForegroundControlId: string | null;
  workflowControllers: Map<string, unknown>;
  workflowChildStops: Map<string, unknown>;
};

type NativeContext = {
  cwd: string;
  hasUI: boolean;
  ui: Record<string, unknown>;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | null;
  };
  modelRegistry: {
    getAvailable(): never[];
    getRegisteredProviderIds(): never[];
  };
};

type NativeAgent = {
  name: string;
  description: string;
  systemPrompt: string;
  systemPromptMode: 'replace';
  inheritGlobalContext: false;
  inheritProjectContext: false;
  inheritSkills: false;
};

type NativeExecutorDependencies = {
  pi: {
    events: NativeEventBus;
    getSessionName(): undefined;
    sendMessage(): void;
  };
  state: NativeState;
  config: {
    worktree: false;
    worktreeProvider: 'native';
    worktreeBaseDir: string;
  };
  asyncByDefault: true;
  tempArtifactsDir: string;
  getSubagentSessionRoot(): string;
  expandTilde(value: string): string;
  discoverAgents(): { agents: NativeAgent[] };
};

type NativeExecutorModule = {
  createSubagentExecutor(
    dependencies: NativeExecutorDependencies,
  ): NativeExecutor;
};

type NativeRpcModule = {
  registerSubagentRpcBridge(options: {
    events: NativeEventBus;
    state: NativeState;
    asyncDirRoot: string;
    resultsDir: string;
    getContext(): NativeContext;
    execute(...args: unknown[]): Promise<unknown>;
  }): NativeRpcRegistration;
};

type ChildSessionModule = {
  setChildSessionFactory(factory: unknown): void;
  setChildSessionFactoryModule(modulePath: string | undefined): void;
  childSessionFactoryModule(): string | undefined;
};

type NativeTypesModule = {
  ASYNC_DIR: string;
  RESULTS_DIR: string;
};

type ScriptedFixtureModule = {
  default(): unknown;
};

export type NativeRuntimeHostOptions = {
  events?: NativeEventBus;
  failAfterRegistration?: boolean;
  reattach?: boolean;
  sessionId?: string;
  sessionFile?: string;
};

export function nativeFixtureFactoryModulePath(): string | undefined {
  return lastChildSessionModule?.childSessionFactoryModule();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fixtureGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: 'ignore',
  });
}

export async function createNativeRuntimeHost(
  sandbox: string,
  options: NativeRuntimeHostOptions = {},
) {
  const savedEnvironment = { ...process.env };
  const savedHomeFunction = os.homedir;
  let environmentRestored = false;
  let childSessionModule: ChildSessionModule | undefined;
  let registration: NativeRpcRegistration | undefined;
  let disposed = false;
  const restoreEnvironment = () => {
    if (environmentRestored) return;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
    os.homedir = savedHomeFunction;
    syncBuiltinESMExports();
    environmentRestored = true;
  };
  const disposeFixtureRuntime = () => {
    try {
      registration?.dispose();
    } finally {
      try {
        childSessionModule?.setChildSessionFactory(undefined);
      } finally {
        try {
          childSessionModule?.setChildSessionFactoryModule(undefined);
        } finally {
          restoreEnvironment();
        }
      }
    }
  };
  const home = join(sandbox, 'home');
  const temp = join(sandbox, 'tmp');
  const agentDirectory = join(home, '.pi', 'agent');
  const nativeTempRoot = join(sandbox, 'native-temp');
  const artifactsDirectory = join(sandbox, 'artifacts');
  const sessionDirectory = join(sandbox, 'sessions');
  const repository = join(sandbox, 'repository');
  const callsPath = join(sandbox, 'scripted-model-calls.jsonl');

  try {
    for (const key of Object.keys(process.env)) {
      if (
        ![
          'PATH',
          'LANG',
          'LC_ALL',
          'USER',
          'LOGNAME',
          'SHELL',
          'SystemRoot',
        ].includes(key)
      )
        delete process.env[key];
    }
    process.env.HOME = home;
    process.env.TMPDIR = temp;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    process.env.PI_SUBAGENTS_TEMP_ROOT = nativeTempRoot;
    process.env.PI_AUTONOMOUS_SMOKE_CALLS = callsPath;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.NODE_OPTIONS = '';
    process.env.NODE_PATH = '';
    os.homedir = () => home;
    syncBuiltinESMExports();

    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(temp, { recursive: true }),
      mkdir(agentDirectory, { recursive: true }),
      mkdir(artifactsDirectory, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(repository, { recursive: true }),
    ]);

    const packageJson = JSON.parse(
      await readFile(
        join(projectRoot, 'node_modules/pi-subagents/package.json'),
        'utf8',
      ),
    ) as { version?: unknown };
    if (packageJson.version !== '0.76.1') {
      throw new Error(
        `Fixture private seams are pinned to pi-subagents 0.76.1; found ${String(packageJson.version)}.`,
      );
    }

    if (options.reattach) {
      await Promise.all([
        access(join(repository, '.git')),
        access(join(repository, 'plan.md')),
        access(join(repository, 'check.mjs')),
      ]);
    } else {
      fixtureGit(repository, 'init', '-b', 'feature');
      const gitConfig = [
        ['user.email', 'native-fixture@example.test'],
        ['user.name', 'Native Runtime Fixture'],
        ['commit.gpgSign', 'false'],
        ['core.hooksPath', '/dev/null'],
      ] as const;
      for (const [key, value] of gitConfig)
        fixtureGit(repository, 'config', key, value);
      await writeFile(
        join(repository, 'plan.md'),
        '### Task 1: Deliver fixture\n- [ ] Deliver fixture\n',
      );
      await writeFile(
        join(repository, 'check.mjs'),
        'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; assert.equal(readFileSync("result.txt", "utf8"), "autonomous runtime smoke\\n");\n',
      );
      fixtureGit(repository, 'add', 'plan.md', 'check.mjs');
      fixtureGit(repository, 'commit', '-m', 'Native runtime fixture baseline');
    }

    const listeners = new Map<string, Set<EventHandler>>();
    const droppedReplies = new Set<string>();
    const droppedReplyWaiters = new Map<string, () => void>();
    const localEvents: NativeEventBus = {
      on(name: string, handler: EventHandler) {
        const handlers = listeners.get(name) ?? new Set<EventHandler>();
        handlers.add(handler);
        listeners.set(name, handlers);
        return () => {
          handlers.delete(handler);
          if (handlers.size === 0) listeners.delete(name);
        };
      },
      emit(name: string, payload: unknown) {
        if (name.startsWith(RPC_REPLY_PREFIX) && isRecord(payload)) {
          const requestId = payload.requestId;
          if (
            typeof requestId === 'string' &&
            droppedReplies.delete(requestId)
          ) {
            droppedReplyWaiters.get(requestId)?.();
            droppedReplyWaiters.delete(requestId);
            return;
          }
        }
        for (const handler of [...(listeners.get(name) ?? [])])
          handler(payload);
      },
    };
    const events = options.events ?? localEvents;

    const jiti = createJiti(import.meta.url);
    const nativeRoot = join(projectRoot, 'node_modules/pi-subagents');
    const [executorModule, rpcModule, importedChildSessionModule, nativeTypes] =
      await Promise.all([
        jiti.import<NativeExecutorModule>(
          join(nativeRoot, 'src/runs/foreground/subagent-executor.js'),
        ),
        jiti.import<NativeRpcModule>(join(nativeRoot, 'src/extension/rpc.js')),
        jiti.import<ChildSessionModule>(
          join(nativeRoot, 'src/runs/shared/child-session.js'),
        ),
        jiti.import<NativeTypesModule>(join(nativeRoot, 'src/shared/types.js')),
      ]);
    childSessionModule = importedChildSessionModule;
    lastChildSessionModule = importedChildSessionModule;
    const { createSubagentExecutor } = executorModule;
    const { registerSubagentRpcBridge } = rpcModule;
    const fixtureFactoryPath = join(
      projectRoot,
      'test/fixtures/autonomous-scripted-session.mjs',
    );
    const fixtureModule = (await import(
      pathToFileURL(fixtureFactoryPath).href
    )) as ScriptedFixtureModule;
    const scriptedFixture = fixtureModule.default;
    childSessionModule.setChildSessionFactoryModule(fixtureFactoryPath);
    childSessionModule.setChildSessionFactory(scriptedFixture());

    let currentSessionId =
      options.sessionId ?? `native-contract-${randomUUID()}`;
    const context: NativeContext = {
      cwd: repository,
      hasUI: false,
      ui: {},
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => options.sessionFile ?? null,
      },
      modelRegistry: {
        getAvailable: () => [],
        getRegisteredProviderIds: () => [],
      },
    };
    const agents: NativeAgent[] = ['worker', 'reviewer'].map((name) => ({
      name,
      description: `Deterministic native contract fixture ${name}`,
      systemPrompt: '',
      systemPromptMode: 'replace',
      inheritGlobalContext: false,
      inheritProjectContext: false,
      inheritSkills: false,
    }));

    let state: NativeState;
    let executor: NativeExecutor;

    const createRuntime = () => {
      state = {
        baseCwd: repository,
        currentSessionId: options.sessionFile ?? currentSessionId,
        asyncJobs: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
        workflowControllers: new Map(),
        workflowChildStops: new Map(),
      };
      executor = createSubagentExecutor({
        pi: { events, getSessionName: () => undefined, sendMessage() {} },
        state,
        config: {
          worktree: false,
          worktreeProvider: 'native',
          worktreeBaseDir: join(sandbox, 'native-worktrees'),
        },
        asyncByDefault: true,
        tempArtifactsDir: artifactsDirectory,
        getSubagentSessionRoot: () => sessionDirectory,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents }),
      });
      registration = registerSubagentRpcBridge({
        events,
        state,
        asyncDirRoot: nativeTypes.ASYNC_DIR,
        resultsDir: nativeTypes.RESULTS_DIR,
        getContext: () => context,
        execute: (...args: unknown[]) => executor.executePublic(...args),
      });
    };
    createRuntime();
    if (options.failAfterRegistration)
      throw new Error('Fixture setup fault after native registration.');

    const rpc = async (
      method: RpcMethod,
      params?: Record<string, unknown>,
      options: { dropReply?: boolean; timeoutMs?: number } = {},
    ): Promise<RpcResult> => {
      const requestId = randomUUID();
      const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
      const timeoutMs = options.timeoutMs ?? 15_000;
      let unsubscribe: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      const result = new Promise<RpcResult>((resolveResult, rejectResult) => {
        timer = setTimeout(() => {
          unsubscribe?.();
          droppedReplyWaiters.delete(requestId);
          rejectResult(
            new Error(
              `Native RPC ${method}/${requestId} timed out after ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
        if (options.dropReply) {
          droppedReplies.add(requestId);
          droppedReplyWaiters.set(requestId, () => {
            resolveResult({ requestId, delivered: false });
          });
        } else {
          unsubscribe = events.on(replyEvent, (reply) => {
            resolveResult({ requestId, delivered: true, reply });
          });
        }
        events.emit(RPC_REQUEST_EVENT, {
          version: 1,
          requestId,
          method,
          ...(params ? { params } : {}),
        });
      });
      try {
        return await result;
      } finally {
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        droppedReplyWaiters.delete(requestId);
        droppedReplies.delete(requestId);
      }
    };

    const executeTool = async (params: Record<string, unknown>) =>
      executor.executePublic(
        `fixture-tool-${randomUUID()}`,
        params,
        new AbortController().signal,
        undefined,
        context,
      );

    const replaceRuntime = () => {
      registration?.dispose();
      createRuntime();
    };

    const host = {
      sandbox,
      repository,
      callsPath,
      nativeRoot,
      asyncDirRoot: nativeTypes.ASYNC_DIR,
      resultsDir: nativeTypes.RESULTS_DIR,
      events,
      context,
      rpc,
      executeTool,
      replaceRuntime,
      setSessionId(value: string) {
        currentSessionId = value;
        state.currentSessionId = options.sessionFile ?? value;
      },
      get sessionId() {
        return currentSessionId;
      },
      get executor() {
        return executor;
      },
      async calls() {
        try {
          return (await readFile(callsPath, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          if (isRecord(error) && error.code === 'ENOENT') return [];
          throw error;
        }
      },
      async seedStatus(input: {
        runId: string;
        state: 'running' | 'queued' | 'paused';
        pid?: number;
        runnerProcessInstanceId?: string;
      }) {
        const asyncDir = join(nativeTypes.ASYNC_DIR, input.runId);
        await mkdir(asyncDir, { recursive: true });
        const now = Date.now();
        await writeFile(
          join(asyncDir, 'status.json'),
          JSON.stringify({
            lifecycleArtifactVersion: 3,
            runId: input.runId,
            sessionId: currentSessionId,
            mode: 'single',
            state: input.state,
            ...(input.pid !== undefined ? { pid: input.pid } : {}),
            startedAt: now,
            lastUpdate: now,
            cwd: repository,
            ...(input.runnerProcessInstanceId
              ? {
                  processTerminal: {
                    version: 1,
                    state: 'pending',
                    runId: input.runId,
                    runnerProcessInstanceId: input.runnerProcessInstanceId,
                  },
                }
              : {}),
            steps: [
              {
                agent: 'worker',
                status: input.state === 'queued' ? 'pending' : input.state,
                startedAt: now,
              },
            ],
          }),
        );
        return asyncDir;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        disposeFixtureRuntime();
      },
    };

    return host;
  } catch (error) {
    disposeFixtureRuntime();
    throw error;
  }
}
