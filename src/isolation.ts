import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RunCommand } from './git.js';
import { BOOTSTRAP_LOCKS } from './lanes.js';
import { materializeApprovedPlan, parsePlan, readPlan } from './plan.js';
import { required } from './required.js';
import type {
  IsolationRecovery,
  PlanExecRun,
  QuarantinedExecution,
} from './types.js';

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === '' ||
    (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part))
  );
}

export async function isolationGit(
  command: RunCommand,
  cwd: string,
  args: string[],
  raw = false,
): Promise<string> {
  const result = await command(
    'git',
    [
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    cwd,
  );
  if (result.code !== 0)
    throw new Error(
      `Isolation Git observation failed: ${result.stderr || result.stdout}`,
    );
  return raw ? result.stdout : result.stdout.trim();
}

export async function isolationPreview(
  run: PlanExecRun,
  targetInput: string,
  command: RunCommand,
): Promise<IsolationRecovery> {
  if (!isAbsolute(targetInput))
    throw new Error('Isolation target must be an absolute new directory.');
  const target = join(
    await realpath(dirname(targetInput)),
    targetInput.split(sep).filter(Boolean).at(-1) ?? '',
  );
  if (target !== resolve(targetInput))
    throw new Error(
      'Isolation target must use its canonical parent path, not a symlink alias.',
    );
  const existing = run.isolationRecovery;
  if (existing?.target === target) return existing;
  if (existing && existing.state !== 'active')
    throw new Error(
      'Finish the pending isolation target before requesting another.',
    );
  if (
    run.goal ||
    run.stage !== 'implementation' ||
    !run.activeOperation ||
    run.activeOperation.service !== 'bridge' ||
    run.activeOperation.kind !== 'implementation' ||
    !run.activeOperation.requestDigest ||
    !run.activeOperation.params
  )
    throw new Error(
      'Isolated recovery currently requires a preserved Bridge implementation attempt with its immutable request.',
    );
  if (
    run.status === 'cancel_pending' ||
    run.status === 'cancelled' ||
    run.status === 'completed' ||
    run.status === 'completed_with_findings'
  )
    throw new Error(
      'A cancelled or completed run cannot be isolated for continuation.',
    );
  if (
    run.localOperationActive ||
    run.archiveOperation ||
    run.outputPromotion ||
    run.lanePreparation
  )
    throw new Error(
      'Reconcile owned local Git/check/bootstrap operations before isolating the model attempt.',
    );
  const sourceRoot = await realpath(
    await isolationGit(command, run.worktreeCwd, [
      'rev-parse',
      '--show-toplevel',
    ]),
  );
  for (const source of [
    sourceRoot,
    await realpath(run.repositoryRoot),
    ...(run.quarantinedExecutions ?? []).map((entry) => entry.cwd),
  ]) {
    if (within(source, target) || within(target, source))
      throw new Error(
        'New checkout must be outside and independent of every current or quarantined repository.',
      );
  }
  try {
    await lstat(target);
    throw new Error('Isolation target already exists; choose a new directory.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const actualBranch = await isolationGit(command, run.worktreeCwd, [
    'symbolic-ref',
    '--short',
    'HEAD',
  ]);
  if (actualBranch !== run.branch)
    throw new Error(
      'Execution branch changed; review and reconcile the recorded branch before isolated recovery.',
    );
  const planPath = required(run.planPath);
  if (!within(sourceRoot, planPath))
    throw new Error('Plan is outside the execution checkout.');
  const currentPlan = await readPlan(planPath);
  if (currentPlan.hash !== run.planHash)
    throw new Error(
      'Plan structure changed; review/adopt it before isolated recovery.',
    );
  const task = currentPlan.tasks.find(
    (entry) => entry.id === run.activeOperation?.taskId,
  );
  if (!task) throw new Error('Interrupted task is not in the checked plan.');
  const scopeText = [task.title, ...task.items].join(' ');
  if (scopeText.includes(sourceRoot) || scopeText.includes(run.repositoryRoot))
    throw new Error(
      'Interrupted task names old absolute repository paths; review the target contract before isolation.',
    );
  const sideEffects =
    /\b(deploy|publish|payment|charge|production|terraform|kubectl|push)\b/i;
  if (
    sideEffects.test(
      [
        task.title,
        ...task.items,
        ...run.config.requiredChecks.flat(),
        ...run.config.bootstrapCommands.flat(),
      ].join(' '),
    )
  )
    throw new Error(
      'Task/checks may have external side effects; isolated filesystem recovery cannot duplicate these operations.',
    );
  for (const arg of [
    ...run.config.requiredChecks.flat(),
    ...run.config.bootstrapCommands.flat(),
  ]) {
    if (arg.includes(sourceRoot) || arg.includes(run.repositoryRoot))
      throw new Error(
        'Frozen commands reference the old repository by absolute path; review shared resources before recovery.',
      );
  }
  const execution = run.tasks?.[String(task.id)];
  const baseline =
    run.acceptedHead ??
    run.outputTarget?.initialHead ??
    execution?.baselineCommit;
  if (!baseline || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(baseline))
    throw new Error('No immutable accepted baseline is recorded.');
  if (
    (await isolationGit(command, sourceRoot, [
      'rev-parse',
      `${baseline}^{commit}`,
    ])) !== baseline
  )
    throw new Error(
      'Accepted baseline does not resolve to the recorded commit.',
    );
  for (const accepted of Object.values(run.tasks ?? {}).filter(
    (entry) => entry.state === 'accepted',
  )) {
    if (!accepted.acceptedCommit)
      throw new Error('Accepted task lacks its commit evidence.');
    await isolationGit(command, sourceRoot, [
      'merge-base',
      '--is-ancestor',
      accepted.acceptedCommit,
      baseline,
    ]);
  }
  const planRelativePath = relative(sourceRoot, planPath);
  const authorized = run.approvedPlan ?? run.initialPlan;
  const committed = await command(
    'git',
    ['show', `${baseline}:${planRelativePath}`],
    sourceRoot,
  );
  const snapshot =
    authorized?.content ??
    (committed.code === 0 ? committed.stdout : undefined);
  if (!snapshot || parsePlan(planPath, snapshot).hash !== run.planHash)
    throw new Error(
      'Accepted commit and stored plan do not supply the frozen plan structure.',
    );
  const planContent = materializeApprovedPlan(
    planPath,
    snapshot,
    committed.code === 0 ? committed.stdout : undefined,
  );
  const verifiedPlan = parsePlan(planPath, planContent);
  for (const accepted of Object.values(run.tasks ?? {}).filter(
    (entry) => entry.state === 'accepted',
  )) {
    if (
      verifiedPlan.tasks.find((entry) => entry.id === accepted.taskId)
        ?.unchecked.length !== 0
    )
      throw new Error(
        'Accepted baseline does not retain the accepted task checkboxes.',
      );
  }
  const worktreeRelativePath = relative(
    sourceRoot,
    await realpath(run.worktreeCwd),
  );
  const baselineFiles = new Set(
    (
      await isolationGit(
        command,
        sourceRoot,
        ['ls-tree', '-r', '--name-only', '-z', baseline],
        true,
      )
    ).split('\0'),
  );
  const bootstrap = run.config.bootstrapCommands.length
    ? run.config.bootstrapCommands
    : BOOTSTRAP_LOCKS.filter(([file]) =>
        baselineFiles.has(join(worktreeRelativePath, file)),
      )
        .slice(0, 1)
        .map(([, command]) => [...command]);
  const intentDigest = createHash('sha256')
    .update(
      JSON.stringify({
        target,
        sourceRoot,
        baseline,
        planContent,
        generation: (run.executionGeneration ?? 0) + 1,
        taskId: task.id,
        taskTitle: task.title,
        taskItems: task.items,
        bootstrap,
        config: run.config,
      }),
    )
    .digest('hex');
  return {
    id: randomUUID(),
    state: 'fenced',
    generation: (run.executionGeneration ?? 0) + 1,
    stopGeneration: (run.stopGeneration ?? 0) + 1,
    target,
    sourceRoot,
    worktreeRelativePath,
    planRelativePath,
    planContent,
    baseline,
    branch: run.branch,
    authorName: await isolationGit(command, sourceRoot, [
      'config',
      '--get',
      'user.name',
    ]),
    authorEmail: await isolationGit(command, sourceRoot, [
      'config',
      '--get',
      'user.email',
    ]),
    taskId: task.id,
    taskTitle: task.title,
    taskItems: task.items,
    bootstrapCommands: bootstrap,
    intentDigest,
    requestedBy: '',
    requestedAt: Date.now(),
  };
}

export async function quarantineExecution(
  run: PlanExecRun,
  recovery: IsolationRecovery,
  command: RunCommand,
): Promise<QuarantinedExecution> {
  const observedHead = await isolationGit(command, run.worktreeCwd, [
    'rev-parse',
    'HEAD',
  ]);
  const inventory = await isolationGit(
    command,
    run.worktreeCwd,
    ['status', '--short', '--untracked-files=all', '--ignored=matching'],
    true,
  );
  const entries = inventory.split('\n').filter(Boolean);
  return {
    id: recovery.id,
    observedHead,
    baseline: recovery.baseline,
    commitDelta: await isolationGit(command, run.worktreeCwd, [
      'log',
      '--oneline',
      '--max-count=50',
      `${recovery.baseline}..${observedHead}`,
    ]),
    generation: run.executionGeneration ?? 0,
    operation: required(run.activeOperation),
    repositoryRoot: run.repositoryRoot,
    cwd: run.worktreeCwd,
    branch: run.branch,
    planPath: required(run.planPath),
    ...(run.progressPath ? { progressPath: run.progressPath } : {}),
    ...(run.tasks ? { tasks: run.tasks } : {}),
    inventory:
      inventory.length <= 32_768
        ? inventory
        : `${inventory.slice(0, 32_768)}\n[Inventory truncated; inspect the preserved old tree for remaining paths.]`,
    inventoryEntries: entries.length,
    ignoredEntries: entries.filter((entry) => entry.startsWith('!!')).length,
    quarantinedAt: Date.now(),
    ...(run.error ? { error: run.error } : {}),
  };
}

export async function prepareIsolationDirectory(
  recovery: IsolationRecovery,
): Promise<void> {
  if ((await realpath(dirname(recovery.target))) !== dirname(recovery.target))
    throw new Error(
      'Isolation target parent changed or is a symlink; refusing writes.',
    );
  const marker = join(recovery.target, '.plan-exec-isolation.json');
  const identity = JSON.stringify({
    id: recovery.id,
    target: recovery.target,
    baseline: recovery.baseline,
  });
  let targetInfo: Stats | undefined;
  try {
    targetInfo = await lstat(recovery.target);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  if (targetInfo) {
    if (
      !targetInfo.isDirectory() ||
      targetInfo.isSymbolicLink() ||
      (await realpath(recovery.target)) !== recovery.target ||
      (await readFile(marker, 'utf8')) !== identity
    )
      throw new Error(
        'Isolation directory ownership cannot be verified; target preserved without reuse.',
      );
    return;
  }
  // A crash cannot leave the public target visible without its complete owner marker.
  const staging = join(
    dirname(recovery.target),
    `.plan-exec-isolation-${recovery.id}`,
  );
  try {
    await mkdir(staging, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  const stageInfo = await lstat(staging);
  if (
    !stageInfo.isDirectory() ||
    stageInfo.isSymbolicLink() ||
    (await realpath(staging)) !== staging
  )
    throw new Error(
      'Isolation staging directory is not private and canonical.',
    );
  const markerName = '.plan-exec-isolation.json';
  const entries = await readdir(staging);
  if (
    entries.some(
      (name) => name !== markerName && name !== `${markerName}.tmp`,
    ) ||
    (entries.includes(markerName) &&
      (await readFile(join(staging, markerName), 'utf8')) !== identity)
  )
    throw new Error(
      'Isolation staging contains unrelated data; nothing was overwritten.',
    );
  await writeFile(join(staging, `${markerName}.tmp`), identity, {
    mode: 0o600,
  });
  await rename(join(staging, `${markerName}.tmp`), join(staging, markerName));
  try {
    await lstat(recovery.target);
    throw new Error(
      'Isolation destination appeared during preparation; refusing replacement.',
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  await rename(staging, recovery.target);
}

export async function verifyResumableIsolation(
  recovery: IsolationRecovery,
  command: RunCommand,
): Promise<void> {
  const gitDir = join(recovery.target, '.git');
  let info: Stats;
  try {
    info = await lstat(gitDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(gitDir)) !== gitDir
  )
    throw new Error(
      'Pending isolation target has shared Git metadata; nothing will be reinitialized.',
    );
  await verifyPrivateFiles(recovery.target);
  const common = await isolationGit(command, recovery.target, [
    'rev-parse',
    '--git-common-dir',
  ]);
  if (resolve(recovery.target, common) !== gitDir)
    throw new Error('Pending isolation target shares a Git common directory.');
  const branchRef = `refs/heads/${recovery.branch}`;
  const headText = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
  if (headText !== `ref: ${branchRef}`)
    throw new Error(
      'Pending isolation HEAD must name the recorded recovery branch; refusing reset.',
    );
  const head = await command(
    'git',
    ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD'],
    recovery.target,
  );
  if (head.code === 0) {
    if (head.stdout.trim() !== recovery.baseline)
      throw new Error(
        'Pending isolation target has new commits; preserve and review them instead of resetting its branch.',
      );
    return;
  }
  try {
    await lstat(join(gitDir, branchRef));
    throw new Error(
      'Pending isolation HEAD is unreadable but its branch ref exists; refusing reset.',
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const ref = await command(
    'git',
    ['--no-optional-locks', 'show-ref', '--verify', '--quiet', branchRef],
    recovery.target,
  );
  if (ref.code !== 1 || ref.stderr.trim())
    throw new Error(
      'Pending isolation HEAD lookup did not prove an unborn branch; refusing reset.',
    );
}

export function isolationCloneCommands(
  recovery: IsolationRecovery,
): string[][] {
  const git = (args: string[]) => [
    'env',
    'GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_CONFIG_NOSYSTEM=1',
    'git',
    '-c',
    'core.hooksPath=/dev/null',
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    ...args,
  ];
  return [
    git(['init', '--initial-branch', recovery.branch]),
    git(['config', 'core.hooksPath', '/dev/null']),
    git(['config', 'core.fsmonitor', 'false']),
    git(['config', 'user.name', recovery.authorName]),
    git(['config', 'user.email', recovery.authorEmail]),
    git([
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--',
      recovery.sourceRoot,
      recovery.baseline,
    ]),
    git(['checkout', '-B', recovery.branch, recovery.baseline]),
  ];
}

async function verifyPrivateFiles(
  root: string,
  directory = root,
): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      if (!within(root, await realpath(path)))
        throw new Error(
          'Recovery checkout contains a symlink to shared external files.',
        );
    } else if (info.isDirectory()) await verifyPrivateFiles(root, path);
    else if (!info.isFile() || info.nlink !== 1)
      throw new Error(
        'Recovery checkout contains hardlinked or special mutable files; use independent copies.',
      );
  }
}

export async function verifyIndependentCheckout(
  recovery: IsolationRecovery,
  command: RunCommand,
): Promise<void> {
  const gitDir = join(recovery.target, '.git');
  if (
    !(await lstat(gitDir)).isDirectory() ||
    (await realpath(gitDir)) !== gitDir
  )
    throw new Error('Recovery target does not have independent Git metadata.');
  const common = await isolationGit(command, recovery.target, [
    'rev-parse',
    '--git-common-dir',
  ]);
  if (resolve(recovery.target, common) !== gitDir)
    throw new Error('Recovery target shares Git common metadata.');
  try {
    await lstat(join(gitDir, 'objects/info/alternates'));
    throw new Error('Recovery target uses object alternates.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  if (await isolationGit(command, recovery.target, ['remote']))
    throw new Error('Recovery target must not retain a writable remote.');
  if (
    (await isolationGit(command, recovery.target, ['rev-parse', 'HEAD'])) !==
    recovery.baseline
  )
    throw new Error(
      'Recovery target moved from the accepted baseline before activation.',
    );
  const tree = await isolationGit(command, recovery.target, [
    'ls-tree',
    '-r',
    recovery.baseline,
  ]);
  for (const line of tree.split('\n')) {
    if (line.startsWith('160000'))
      throw new Error('Submodule baselines require explicit isolation review.');
    if (line.startsWith('120000')) {
      const path = line.split('\t')[1];
      if (
        !path ||
        !within(recovery.target, await realpath(join(recovery.target, path)))
      )
        throw new Error('Tracked symlink escapes the independent checkout.');
    }
  }
  await verifyPrivateFiles(recovery.target);
  await writeFile(
    join(gitDir, 'info/exclude'),
    '.plan-exec-isolation.json\n.ralphex/\n.pi/\n.pi-subagents/\n',
  );
  const planPath = join(recovery.target, recovery.planRelativePath);
  const changes = await isolationGit(
    command,
    recovery.target,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    true,
  );
  for (const change of changes.split('\0').filter(Boolean)) {
    const path = change.slice(3);
    if (
      path !== recovery.planRelativePath ||
      (await readFile(planPath, 'utf8')) !== recovery.planContent
    )
      throw new Error(
        'Isolation target has unexpected changes; preserve and review them before activation.',
      );
  }
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, recovery.planContent);
}

export function activateIsolation(
  run: PlanExecRun,
  recovery: IsolationRecovery,
): PlanExecRun {
  const cwd = join(recovery.target, recovery.worktreeRelativePath);
  const interruptedTaskId = run.quarantinedExecutions?.find(
    (entry) => entry.id === recovery.id,
  )?.operation.taskId;
  const tasks = Object.fromEntries(
    Object.entries(run.tasks ?? {}).map(([key, task]) => {
      const next = { ...task };
      delete next.laneCwd;
      delete next.laneBranch;
      delete next.recoverySource;
      delete next.recoveryHistory;
      if (task.state !== 'accepted') {
        delete next.candidateCommit;
        delete next.operationId;
        if (task.taskId === interruptedTaskId) {
          next.state = task.externalPrerequisite
            ? 'waiting_external'
            : 'retry_wait';
          if (!task.externalPrerequisite) next.nextAttemptAt = 0;
          next.baselineCommit = recovery.baseline;
        }
      }
      return [key, next];
    }),
  );
  const next: PlanExecRun = {
    ...run,
    status: 'paused',
    userStopped: true,
    repositoryRoot: recovery.target,
    worktreeCwd: cwd,
    planPath: join(recovery.target, recovery.planRelativePath),
    branch: recovery.branch,
    acceptedHead: recovery.baseline,
    tasks,
    nextAttemptAt: 0,
    isolationRecovery: { ...recovery, state: 'active' },
    outputTarget: {
      cwd: recovery.target,
      branch: recovery.branch,
      initialHead: recovery.baseline,
      planRelativePath: recovery.planRelativePath,
    },
    wakeReason:
      'Isolated recovery activated; old operation and partial work remain quarantined, not retired.',
  };
  delete next.activeOperation;
  delete next.failedOperation;
  delete next.progressPath;
  delete next.error;
  delete next.blocked;
  delete next.needsAttention;
  return next;
}
