import { stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionLifetime } from './types.js';

export interface LegacyOperationBinding {
  operationId: string;
  ownerRunId: string;
  /** The original Bridge request digest, not a digest of native_params. */
  requestDigest: string;
}

export interface LegacyLaunchRejection extends LegacyOperationBinding {
  version: 1;
  source: 'subagents-rpc';
  requestId: string;
  method: 'spawn';
  code: 'invalid_params';
  message: string;
}

/** Identity/intent only: neither a stop receipt nor a bound row proves retirement. */
export interface LegacyOperationMapping extends LegacyOperationBinding {
  binding: 'dispatching' | 'bound' | 'unknown';
  runId?: string;
  asyncDir?: string;
  /** Copied only from nativeParams.rpcRequestId, never inferred from status text. */
  rpcRequestId?: string;
  nativeParams?: Record<string, unknown>;
  nativeParamsJson?: string;
  nativeCorrelated: boolean;
  executionLifetime?: ExecutionLifetime;
  cancelRequested: boolean;
  stopReceiptState?: 'stopping' | 'stopped';
  launchRejection?: LegacyLaunchRejection;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export type LegacyOperationLookup =
  | { state: 'found'; operation: LegacyOperationMapping }
  | { state: 'missing'; source: 'database' | 'operation' }
  | { state: 'unavailable'; reason: string }
  | { state: 'incompatible'; reason: string }
  | { state: 'mismatch'; field: keyof LegacyOperationBinding };

const BUSY_TIMEOUT_MS = 100;
const MAX_ROW_BYTES = 1_048_576;
const COLUMNS = [
  'operation_id',
  'request_digest',
  'owner_run_id',
  'execution_lifetime',
  'native_correlated',
  'cancel_requested',
  'stop_receipt_state',
  'native_params',
  'launch_rejection',
  'binding',
  'run_id',
  'async_dir',
  'error',
  'created_at',
  'updated_at',
] as const;

/**
 * Read only schema 7, by exact operation ID, with a single SQLite read snapshot.
 * Missing storage/rows are NOT non-start or replay-safety evidence. This never
 * adopts a run, dispatches work, or modifies journal rows/schema.
 *
 * SQLite is loaded lazily and opened readOnly, not immutable: live WAL reads need
 * the matching WAL/SHM and SQLite may manage sidecars. Offline copies must be a
 * quiescent checkpointed DB or a consistent SQLite snapshot including its WAL;
 * copying only a live DB can omit committed identities. No filesystem-wide
 * immutability guarantee is made. Lock waits and returned row size are bounded.
 */
export async function lookupLegacyOperation(
  filePath: string,
  expected: LegacyOperationBinding,
): Promise<LegacyOperationLookup> {
  if (
    !nonempty(filePath) ||
    !nonempty(expected.operationId) ||
    !nonempty(expected.ownerRunId) ||
    !nonempty(expected.requestDigest)
  ) {
    return {
      state: 'unavailable',
      reason:
        'A source path and exact operation/owner/digest binding are required',
    };
  }
  try {
    if (!(await stat(filePath)).isFile()) {
      return {
        state: 'unavailable',
        reason: 'Journal source is not a regular file',
      };
    }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return { state: 'missing', source: 'database' };
    }
    return { state: 'unavailable', reason: diagnostic(error) };
  }

  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(filePath, { readOnly: true });
    db.exec(
      `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN`,
    );
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 7) {
      return {
        state: 'incompatible',
        reason: `Only Bridge journal schema 7 is supported (observed ${String(version)})`,
      };
    }
    const columns = db.prepare("PRAGMA table_info('operations')").all();
    if (
      !COLUMNS.every((name) =>
        columns.some((column) => column.name === name),
      ) ||
      !columns.some(
        (column) => column.name === 'operation_id' && column.pk === 1,
      ) ||
      columns.filter((column) => column.pk !== 0).length !== 1
    ) {
      return {
        state: 'incompatible',
        reason: 'Schema 7 operations table or required columns/key are missing',
      };
    }
    // Measure before materializing JSON or large text. Both reads share a snapshot.
    const size = db
      .prepare(
        `SELECT ${COLUMNS.map((name) => `coalesce(length(CAST(${name} AS BLOB)), 0)`).join(' + ')} AS bytes FROM operations WHERE operation_id = ? LIMIT 1`,
      )
      .get(expected.operationId);
    if (!size) return { state: 'missing', source: 'operation' };
    if (typeof size.bytes !== 'number' || size.bytes > MAX_ROW_BYTES) {
      return {
        state: 'incompatible',
        reason: `Operation row exceeds ${MAX_ROW_BYTES} bytes`,
      };
    }
    const row = db
      .prepare(
        `SELECT ${COLUMNS.join(', ')} FROM operations WHERE operation_id = ? LIMIT 1`,
      )
      .get(expected.operationId);
    if (!row)
      return {
        state: 'unavailable',
        reason: 'Operation disappeared within read snapshot',
      };
    for (const [field, column] of [
      ['operationId', 'operation_id'],
      ['ownerRunId', 'owner_run_id'],
      ['requestDigest', 'request_digest'],
    ] as const) {
      if (row[column] !== expected[field]) return { state: 'mismatch', field };
    }
    try {
      const operation = parseMapping(row, expected);
      return operation
        ? { state: 'found', operation }
        : {
            state: 'incompatible',
            reason: 'Invalid persisted schema 7 operation mapping or evidence',
          };
    } catch (error) {
      return {
        state: 'incompatible',
        reason: `Invalid persisted schema 7 JSON: ${diagnostic(error)}`,
      };
    }
  } catch (error) {
    // Locked, corrupt, permission denied and SQLite loading/open errors stay fenced.
    return { state: 'unavailable', reason: diagnostic(error) };
  } finally {
    db?.close();
  }
}

function parseMapping(
  row: Record<string, unknown>,
  expected: LegacyOperationBinding,
): LegacyOperationMapping | undefined {
  if (
    (row.binding !== 'dispatching' &&
      row.binding !== 'bound' &&
      row.binding !== 'unknown') ||
    (row.native_correlated !== 0 && row.native_correlated !== 1) ||
    (row.cancel_requested !== 0 && row.cancel_requested !== 1) ||
    (row.stop_receipt_state !== null &&
      row.stop_receipt_state !== 'stopping' &&
      row.stop_receipt_state !== 'stopped') ||
    !timestamp(row.created_at) ||
    !timestamp(row.updated_at)
  )
    return undefined;
  for (const field of [
    'run_id',
    'async_dir',
    'error',
    'native_params',
    'execution_lifetime',
    'launch_rejection',
  ]) {
    if (row[field] !== null && typeof row[field] !== 'string') return undefined;
  }
  if (
    (row.run_id !== null && !nonempty(row.run_id)) ||
    (row.async_dir !== null && !nonempty(row.async_dir)) ||
    (row.binding === 'bound' && !nonempty(row.run_id)) ||
    (row.binding === 'unknown' && !nonempty(row.error)) ||
    (row.stop_receipt_state !== null &&
      (row.cancel_requested !== 1 || !nonempty(row.run_id)))
  )
    return undefined;

  const nativeParams: unknown =
    row.native_params === null
      ? undefined
      : JSON.parse(row.native_params as string);
  if (nativeParams !== undefined && !isRecord(nativeParams)) return undefined;
  const rpcRequestId = isRecord(nativeParams)
    ? nativeParams.rpcRequestId
    : undefined;
  if (rpcRequestId !== undefined && !nonempty(rpcRequestId)) return undefined;

  const lifetime: unknown =
    row.execution_lifetime === null
      ? undefined
      : JSON.parse(row.execution_lifetime as string);
  if (lifetime !== undefined && !validLifetime(lifetime)) return undefined;
  const rejection: unknown =
    row.launch_rejection === null
      ? undefined
      : JSON.parse(row.launch_rejection as string);
  if (
    rejection !== undefined &&
    (!validRejection(rejection, expected) ||
      row.binding !== 'unknown' ||
      row.run_id !== null ||
      (rpcRequestId !== undefined && rejection.requestId !== rpcRequestId))
  )
    return undefined;

  return {
    ...expected,
    binding: row.binding,
    ...(typeof row.run_id === 'string' ? { runId: row.run_id } : {}),
    ...(typeof row.async_dir === 'string' ? { asyncDir: row.async_dir } : {}),
    ...(typeof rpcRequestId === 'string' ? { rpcRequestId } : {}),
    ...(isRecord(nativeParams)
      ? { nativeParams, nativeParamsJson: row.native_params as string }
      : {}),
    nativeCorrelated: row.native_correlated === 1,
    ...(validLifetime(lifetime) ? { executionLifetime: lifetime } : {}),
    cancelRequested: row.cancel_requested === 1,
    ...(row.stop_receipt_state
      ? { stopReceiptState: row.stop_receipt_state }
      : {}),
    ...(validRejection(rejection, expected)
      ? { launchRejection: rejection }
      : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validRejection(
  value: unknown,
  expected: LegacyOperationBinding,
): value is LegacyLaunchRejection {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.source === 'subagents-rpc' &&
    value.method === 'spawn' &&
    value.code === 'invalid_params' &&
    nonempty(value.requestId) &&
    nonempty(value.message) &&
    value.operationId === expected.operationId &&
    value.ownerRunId === expected.ownerRunId &&
    value.requestDigest === expected.requestDigest
  );
}

function validLifetime(value: unknown): value is ExecutionLifetime {
  return (
    isRecord(value) &&
    ((value.mode === 'unbounded' && Object.keys(value).length === 1) ||
      (value.mode === 'bounded' &&
        Object.keys(value).length === 2 &&
        typeof value.timeoutMs === 'number' &&
        Number.isSafeInteger(value.timeoutMs) &&
        value.timeoutMs > 0 &&
        value.timeoutMs <= 2_147_483_647))
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
