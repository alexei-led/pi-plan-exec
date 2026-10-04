import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Match Pi's host module aliases, including the legacy package names.
const HOST_PACKAGES = new Set([
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-ai',
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-tui',
  '@sinclair/typebox',
  'typebox',
]);
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const invalid = [];
for (const name of HOST_PACKAGES) {
  for (const field of ['dependencies', 'optionalDependencies']) {
    if (Object.hasOwn(packageJson[field] ?? {}, name))
      invalid.push(`${field}: ${name}`);
  }
  const expectedPeerRange =
    name === '@earendil-works/pi-coding-agent' ? '^1.0.2' : '*';
  if (
    Object.hasOwn(packageJson.peerDependencies ?? {}, name) &&
    packageJson.peerDependencies[name] !== expectedPeerRange
  )
    invalid.push(`peerDependencies: ${name} (expected ${expectedPeerRange})`);
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    if (Array.isArray(packageJson[field]) && packageJson[field].includes(name))
      invalid.push(`${field}: ${name}`);
  }
}
if (invalid.length > 0) {
  console.error(
    `Host-provided extension packages must be declared in peerDependencies with the tested host range, not installed or bundled as runtime dependencies:\n${invalid.map((entry) => `- ${entry}`).join('\n')}`,
  );
  process.exit(1);
}

const ALWAYS_ALLOWED = new Set(['LICENSE', 'README.md', 'package.json']);
const REQUIRED = new Set([
  'LICENSE',
  'README.md',
  'package.json',
  'skills/exec-plan/SKILL.md',
  'skills/exec-plan/references/recovery.md',
  'src/index.ts',
  'src/local-operation-worker.mjs',
]);
const RUNTIME_PATHS = [
  /^src\/[^/]+\.(?:ts|mjs)$/,
  /^skills\/exec-plan\/(?:SKILL\.md|references\/[^/]+\.md)$/,
];

const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
);
const parsed = JSON.parse(output);
const manifest = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
if (!manifest || !Array.isArray(manifest.files)) {
  throw new Error('npm pack did not return a package file manifest.');
}

const files = manifest.files.map((entry) => entry.path).sort();
const unexpected = files.filter(
  (file) =>
    !ALWAYS_ALLOWED.has(file) &&
    !RUNTIME_PATHS.some((pattern) => pattern.test(file)),
);
const missing = [...REQUIRED].filter((file) => !files.includes(file));

if (unexpected.length > 0 || missing.length > 0) {
  if (unexpected.length > 0) {
    console.error(
      `Unexpected package files:\n${unexpected.map((file) => `- ${file}`).join('\n')}`,
    );
  }
  if (missing.length > 0) {
    console.error(
      `Missing required package files:\n${missing.map((file) => `- ${file}`).join('\n')}`,
    );
  }
  process.exit(1);
}

console.log(
  `${manifest.name}@${manifest.version}: ${files.length} files, ${manifest.unpackedSize} bytes unpacked`,
);
for (const file of files) console.log(`- ${file}`);
