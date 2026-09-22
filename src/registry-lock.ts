import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getSystemErrorName, promisify } from 'node:util';

const RETRY_MS = 50;
const MAX_RETRIES = 100;
const COMPILE_TIMEOUT_MS = 10_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OTHER_PERMISSION_BITS = 0o077;

// Only these stable Node-API v1 declarations are needed; no Node headers,
// node-gyp, downloads, or V8 ABI are involved. Signatures: nodejs/node,
// src/js_native_api.h and src/js_native_api_types.h (Node 22.19.0).
const NATIVE_SOURCE = String.raw`
#include <sys/file.h>
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern int napi_get_cb_info(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
extern int napi_get_value_int32(napi_env, napi_value, int32_t *);
extern int napi_create_int32(napi_env, int32_t, napi_value *);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_throw_error(napi_env, const char *, const char *);

static napi_value try_lock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg, result;
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != 0 || argc != 1 ||
      napi_get_value_int32(env, arg, &fd) != 0 || fd < 0) {
    napi_throw_error(env, NULL, "Invalid registry lock descriptor");
    return NULL;
  }
  int error = flock(fd, LOCK_EX | LOCK_NB) == 0 ? 0 : errno;
  if (napi_create_int32(env, error, &result) != 0) return NULL;
  return result;
}

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  (void)exports;
  napi_value result;
  if (napi_create_function(env, "tryLock", (size_t)-1, try_lock, NULL, &result) != 0)
    return NULL;
  return result;
}
`;

type TryLock = (fd: number) => number;
let nativeBinding: Promise<TryLock> | undefined;

async function loadNativeBinding(): Promise<TryLock> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error(
      'Registry locking requires Darwin or Linux with a C compiler.',
    );
  const uid = process.getuid?.();
  const cache = join(tmpdir(), `pi-plan-exec-registry-lock-${uid}`);
  await mkdir(cache, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const metadata = await lstat(cache);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== uid ||
    (metadata.mode & OTHER_PERMISSION_BITS) !== 0
  )
    throw new Error(`Registry lock compiler cache is not private: ${cache}`);
  const digest = createHash('sha256').update(NATIVE_SOURCE).digest('hex');
  const binary = join(
    cache,
    `${process.platform}-${process.arch}-${digest}.node`,
  );
  try {
    await lstat(binary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const build = await mkdtemp(join(cache, 'build-'));
    try {
      const source = join(build, 'lock.c');
      const output = join(build, 'lock.node');
      await writeFile(source, NATIVE_SOURCE, { mode: PRIVATE_FILE_MODE });
      const args = [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-shared',
        '-fPIC',
      ];
      if (process.platform === 'darwin')
        args.push('-undefined', 'dynamic_lookup');
      args.push(source, '-o', output);
      await promisify(execFile)(
        process.platform === 'darwin' ? '/usr/bin/clang' : '/usr/bin/cc',
        args,
        {
          timeout: COMPILE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
      await chmod(output, PRIVATE_FILE_MODE);
      await rename(output, binary);
    } catch (error) {
      throw new Error(
        'Cannot build registry kernel lock binding; install the platform C compiler.',
        { cause: error },
      );
    } finally {
      await rm(build, { recursive: true, force: true });
    }
  }
  const binding: unknown = createRequire(import.meta.url)(binary);
  if (typeof binding !== 'function')
    throw new Error('Invalid registry kernel lock binding.');
  return binding as TryLock;
}

export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`Timed out acquiring plan-exec registry lock: ${path}`);
  }
}

/** A lock owns one open file description; closing it cannot release a successor. */
export interface RegistryLock {
  release(): Promise<void>;
}

/** Lock files must stay at stable paths and must never be unlinked or replaced. */
export async function acquireLock(
  path: string,
  maxRetries = MAX_RETRIES,
): Promise<RegistryLock> {
  nativeBinding ??= loadNativeBinding().catch((error) => {
    nativeBinding = undefined;
    throw error;
  });
  const tryLock = await nativeBinding;
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const errno = tryLock(handle.fd);
      if (errno === 0) return { release: () => handle.close() };
      const code = getSystemErrorName(-errno);
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK' && code !== 'EINTR')
        throw Object.assign(
          new Error(`Cannot acquire registry lock ${path}: ${code}`),
          { code },
        );
      await delay(RETRY_MS);
    }
    throw new LockTimeoutError(path);
  } catch (error) {
    await handle.close();
    throw error;
  }
}
