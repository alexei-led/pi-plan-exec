export function fixtureGitEnvironment(source = process.env) {
  const environment = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "SystemRoot"]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return { ...environment, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}
