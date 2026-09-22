import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const [payloadPath, digest] = process.argv.slice(2);
const raw = await readFile(payloadPath, 'utf8');
if (createHash('sha256').update(raw).digest('hex') !== digest)
  throw new Error('Plan publication payload digest mismatch.');
const payload = JSON.parse(raw);
if (
  !payload ||
  typeof payload.cwd !== 'string' ||
  typeof payload.path !== 'string' ||
  typeof payload.content !== 'string' ||
  (payload.expectedContent !== null &&
    typeof payload.expectedContent !== 'string')
)
  throw new Error('Invalid plan publication payload.');
const cwd = await realpath(payload.cwd);
const path = resolve(payload.path);
const contained = (target) => {
  const child = relative(cwd, target);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
if (!contained(path))
  throw new Error('Plan publication target is outside its lane.');
if (
  execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd },
  ).length
)
  throw new Error(
    'New lane has unexpected changes; refusing to replace its plan.',
  );
let existing = null;
try {
  if (!(await lstat(path)).isFile())
    throw new Error('Plan publication target is not a regular file.');
  existing = await readFile(path, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (existing !== payload.expectedContent)
  throw new Error('Plan publication target no longer matches the baseline.');
await mkdir(dirname(path), { recursive: true });
if (!contained(await realpath(dirname(path))))
  throw new Error('Plan publication directory is outside its lane.');
const temporary = join(dirname(path), `.plan-exec-${randomUUID()}.tmp`);
const file = await open(temporary, 'wx', 0o600);
try {
  await file.writeFile(payload.content);
  await file.sync();
} finally {
  await file.close();
}
await rename(temporary, path);
const directory = await open(dirname(path), 'r');
try {
  await directory.sync();
} finally {
  await directory.close();
}
