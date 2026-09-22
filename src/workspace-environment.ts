const LOCAL_GIT_VARIABLES = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
]);

function repositoryVariable(name: string): boolean {
  return (
    LOCAL_GIT_VARIABLES.has(name) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)
  );
}

/** A parent's Git hook environment must not redirect a different worktree's commands. */
export function workspaceEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !repositoryVariable(entry[0]),
    ),
  );
}

export function workspaceCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): {
  command: string;
  args: string[];
} {
  if (command !== 'git') return { command, args };
  const observationArgs =
    args[0] === 'diff'
      ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
      : args;
  const gitArgs = [
    '--no-pager',
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    ...observationArgs,
  ];
  const names = Object.keys(environment).filter(repositoryVariable).sort();
  return names.length
    ? {
        command: '/usr/bin/env',
        args: [...names.flatMap((name) => ['-u', name]), command, ...gitArgs],
      }
    : { command, args: gitArgs };
}
