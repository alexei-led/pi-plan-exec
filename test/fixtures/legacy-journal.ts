import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { LegacyOperationBinding } from '../../src/legacy-operation.js';

/** Closed, isolated schema-7 fixture; never imports the removed journal package. */
export async function writeLegacyJournal(
  path: string,
  binding: LegacyOperationBinding,
  patch: Record<string, SQLInputValue> = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA user_version=7; CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY, request_digest TEXT, owner_run_id TEXT,
      execution_lifetime TEXT, native_correlated INTEGER, cancel_requested INTEGER,
      stop_receipt_state TEXT, native_params TEXT, launch_rejection TEXT,
      binding TEXT, run_id TEXT, async_dir TEXT, error TEXT, created_at INTEGER, updated_at INTEGER
    );`);
    const row = {
      operation_id: binding.operationId,
      request_digest: binding.requestDigest,
      owner_run_id: binding.ownerRunId,
      execution_lifetime: '{"mode":"unbounded"}',
      native_correlated: 1,
      cancel_requested: 0,
      stop_receipt_state: null,
      native_params: '{"rpcRequestId":"original-native-rpc"}',
      launch_rejection: null,
      binding: 'bound',
      run_id: 'original-native-run',
      async_dir: null,
      error: null,
      created_at: 1,
      updated_at: 2,
      ...patch,
    };
    db.prepare(
      `INSERT INTO operations (${Object.keys(row).join(',')}) VALUES (${Object.keys(
        row,
      )
        .map(() => '?')
        .join(',')})`,
    ).run(...Object.values(row));
  } finally {
    db.close();
  }
}
