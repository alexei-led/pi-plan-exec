import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, test } from 'vitest';
import { lookupLegacyOperation } from '../src/legacy-operation.js';

const expected = {
  operationId: 'operation-1',
  ownerRunId: 'plan-1',
  requestDigest: 'original-digest',
};
const rpcRequestId = 'f018e739-d3a3-4e49-ae5b-4d9e3248a462';
const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function location() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-operation-'));
  roots.push(root);
  return path.join(root, 'operations.sqlite');
}

// Schema 7 operations table, not the Bridge journal constructor (which migrates).
function fixture(patch: Record<string, SQLInputValue> = {}) {
  const filePath = location();
  const db = new DatabaseSync(filePath);
  databases.push(db);
  db.exec(`
    PRAGMA user_version = 7;
    CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      owner_run_id TEXT,
      execution_lifetime TEXT,
      native_correlated INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      stop_receipt_state TEXT CHECK (stop_receipt_state IN ('stopping', 'stopped')),
      native_params TEXT,
      launch_rejection TEXT,
      binding TEXT NOT NULL CHECK (binding IN ('dispatching', 'bound', 'unknown')),
      run_id TEXT,
      async_dir TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (binding != 'bound' OR run_id IS NOT NULL),
      CHECK (binding != 'unknown' OR error IS NOT NULL)
    ) STRICT;
  `);
  const row = {
    operation_id: expected.operationId,
    request_digest: expected.requestDigest,
    owner_run_id: expected.ownerRunId,
    execution_lifetime: '{"mode":"bounded","timeoutMs":60000}',
    native_correlated: 1,
    cancel_requested: 0,
    stop_receipt_state: null,
    native_params: JSON.stringify({
      rpcRequestId,
      agent: 'frozen-agent',
      prompt: 'original prompt',
    }),
    launch_rejection: null,
    binding: 'bound',
    run_id: 'native-run-1',
    async_dir: '/original/native/path',
    error: null,
    created_at: 100,
    updated_at: 200,
    ...patch,
  };
  db.prepare(
    `INSERT INTO operations (${Object.keys(row).join(',')}) VALUES (${Object.keys(
      row,
    )
      .map(() => '?')
      .join(',')})`,
  ).run(...Object.values(row));
  return { filePath, db, row };
}

function rejection(patch = {}) {
  return {
    version: 1,
    source: 'subagents-rpc',
    requestId: rpcRequestId,
    method: 'spawn',
    code: 'invalid_params',
    message: 'Rejected before execution',
    ...expected,
    ...patch,
  };
}

test('legacy-operation reads exact owner/digest binding without modifying a quiescent database', async () => {
  const { filePath, row } = fixture();
  const before = fs.readFileSync(filePath);
  const result = await lookupLegacyOperation(filePath, expected);
  assert.equal(result.state, 'found');
  if (result.state !== 'found') return;
  assert.deepEqual(result.operation, {
    ...expected,
    rpcRequestId,
    executionLifetime: { mode: 'bounded', timeoutMs: 60000 },
    nativeCorrelated: true,
    cancelRequested: false,
    nativeParams: JSON.parse(String(row.native_params)),
    nativeParamsJson: row.native_params,
    binding: 'bound',
    runId: 'native-run-1',
    asyncDir: '/original/native/path',
    createdAt: 100,
    updatedAt: 200,
  });
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), [
    'operations.sqlite',
  ]);
  assert.equal('replaySafe' in result, false);
  assert.equal('neverStarted' in result, false);
});

for (const field of ['ownerRunId', 'requestDigest'] as const) {
  test(`legacy-operation rejects wrong ${field}`, async () => {
    const { filePath } = fixture();
    assert.deepEqual(
      await lookupLegacyOperation(filePath, { ...expected, [field]: 'wrong' }),
      {
        state: 'mismatch',
        field,
      },
    );
  });
}

test('legacy-operation does not adopt ownerless rows', async () => {
  const { filePath } = fixture({ owner_run_id: null });
  assert.deepEqual(await lookupLegacyOperation(filePath, expected), {
    state: 'mismatch',
    field: 'ownerRunId',
  });
});

test('legacy-operation missing database and row are not absence or replay proof', async () => {
  const absent = path.join(location(), 'missing', 'journal.sqlite');
  assert.deepEqual(await lookupLegacyOperation(absent, expected), {
    state: 'missing',
    source: 'database',
  });
  assert.equal(fs.existsSync(path.dirname(absent)), false);
  const { filePath } = fixture();
  assert.deepEqual(
    await lookupLegacyOperation(filePath, {
      ...expected,
      operationId: 'not-present',
    }),
    { state: 'missing', source: 'operation' },
  );
});

for (const binding of ['dispatching', 'unknown']) {
  test(`legacy-operation preserves ${binding} mapping without claiming non-start`, async () => {
    const { filePath } = fixture({
      binding,
      run_id: null,
      async_dir: null,
      error:
        binding === 'unknown'
          ? 'status says stopped: not identity or proof'
          : null,
    });
    const result = await lookupLegacyOperation(filePath, expected);
    assert.equal(result.state, 'found');
    if (result.state !== 'found') return;
    assert.equal(result.operation.binding, binding);
    assert.equal(result.operation.runId, undefined);
    assert.equal(result.operation.launchRejection, undefined);
    assert.equal('neverStarted' in result.operation, false);
  });
}

for (const stopReceiptState of [null, 'stopping', 'stopped']) {
  test(`legacy-operation preserves cancellation intent and ${stopReceiptState} delivery separately`, async () => {
    const { filePath } = fixture({
      cancel_requested: 1,
      stop_receipt_state: stopReceiptState,
    });
    const result = await lookupLegacyOperation(filePath, expected);
    assert.equal(result.state, 'found');
    if (result.state !== 'found') return;
    assert.equal(result.operation.cancelRequested, true);
    assert.equal(
      result.operation.stopReceiptState,
      stopReceiptState ?? undefined,
    );
    assert.equal('retired' in result.operation, false);
  });
}

test('legacy-operation preserves validated rejection evidence without interpreting retirement', async () => {
  const proof = rejection();
  const { filePath } = fixture({
    binding: 'unknown',
    run_id: null,
    async_dir: null,
    error: 'invalid params',
    launch_rejection: JSON.stringify(proof),
  });
  const result = await lookupLegacyOperation(filePath, expected);
  assert.equal(result.state, 'found');
  if (result.state !== 'found') return;
  assert.deepEqual(result.operation.launchRejection, proof);
  assert.equal(result.operation.rpcRequestId, rpcRequestId);
});

for (const patch of [
  { ownerRunId: 'other' },
  { operationId: 'other' },
  { requestDigest: 'other' },
  { requestId: 'other-rpc' },
  { source: 'status-text' },
  { code: 'execution_failed' },
  { message: '' },
  { version: 2 },
]) {
  test(`legacy-operation rejects malformed rejection ${JSON.stringify(patch)}`, async () => {
    const { filePath } = fixture({
      binding: 'unknown',
      run_id: null,
      error: 'rejected',
      launch_rejection: JSON.stringify(rejection(patch)),
    });
    assert.equal(
      (await lookupLegacyOperation(filePath, expected)).state,
      'incompatible',
    );
  });
}

test('legacy-operation rejects rejection evidence attached to a bound run', async () => {
  const { filePath } = fixture({
    launch_rejection: JSON.stringify(rejection()),
  });
  assert.equal(
    (await lookupLegacyOperation(filePath, expected)).state,
    'incompatible',
  );
});

for (const patch of [
  { native_params: '{broken' },
  { native_params: '[]' },
  { native_params: '{"rpcRequestId":12}' },
  { native_correlated: 2 },
  { execution_lifetime: '{"mode":"bounded","timeoutMs":0}' },
  { created_at: -1 },
  { launch_rejection: '{}' },
  { native_params: JSON.stringify({ prompt: 'x'.repeat(1_048_576) }) },
]) {
  test(`legacy-operation rejects invalid or oversized persisted data (${Object.keys(patch)[0]})`, async () => {
    const { filePath } = fixture(patch);
    assert.equal(
      (await lookupLegacyOperation(filePath, expected)).state,
      'incompatible',
    );
  });
}

test('legacy-operation absent native parameters are preserved, not invented', async () => {
  const { filePath } = fixture({
    native_params: null,
    execution_lifetime: null,
    native_correlated: 0,
  });
  const result = await lookupLegacyOperation(filePath, expected);
  assert.equal(result.state, 'found');
  if (result.state !== 'found') return;
  assert.equal(result.operation.nativeParams, undefined);
  assert.equal(result.operation.rpcRequestId, undefined);
  assert.equal(result.operation.executionLifetime, undefined);
});

test('legacy-operation queries only the requested row even when unrelated history is malformed', async () => {
  const { filePath, db } = fixture();
  db.exec(
    `INSERT INTO operations (operation_id, request_digest, binding, native_params, created_at, updated_at) VALUES ('unrelated', 'other', 'dispatching', '{bad-json', 1, 1)`,
  );
  assert.equal(
    (await lookupLegacyOperation(filePath, expected)).state,
    'found',
  );
});

for (const version of [0, 6, 8]) {
  test(`legacy-operation refuses schema ${version} without migration`, async () => {
    const { filePath, db } = fixture();
    db.exec(`PRAGMA user_version = ${version}`);
    const before = fs.readFileSync(filePath);
    assert.equal(
      (await lookupLegacyOperation(filePath, expected)).state,
      'incompatible',
    );
    assert.deepEqual(fs.readFileSync(filePath), before);
  });
}

test('legacy-operation refuses schema 7 with missing required columns', async () => {
  const { filePath, db } = fixture();
  db.exec('ALTER TABLE operations DROP COLUMN native_params');
  assert.equal(
    (await lookupLegacyOperation(filePath, expected)).state,
    'incompatible',
  );
});

test('legacy-operation reports corrupt and non-file sources unavailable without resetting', async () => {
  const filePath = location();
  fs.writeFileSync(filePath, 'not a sqlite database');
  assert.equal(
    (await lookupLegacyOperation(filePath, expected)).state,
    'unavailable',
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'not a sqlite database');
  assert.equal(
    (await lookupLegacyOperation(path.dirname(filePath), expected)).state,
    'unavailable',
  );
});

test('legacy-operation reports exclusive lock unavailable within bounded wait', async () => {
  const { filePath, db } = fixture();
  db.exec('BEGIN EXCLUSIVE');
  try {
    const result = await lookupLegacyOperation(filePath, expected);
    assert.equal(result.state, 'unavailable');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('legacy-operation reads committed WAL rows and does not observe uncommitted updates', async () => {
  const { filePath, db } = fixture();
  db.exec(
    "PRAGMA journal_mode = WAL; UPDATE operations SET run_id = 'committed-wal-run'; BEGIN IMMEDIATE; UPDATE operations SET run_id = 'uncommitted-run'",
  );
  try {
    const result = await lookupLegacyOperation(filePath, expected);
    assert.equal(result.state, 'found');
    if (result.state !== 'found') return;
    assert.equal(result.operation.runId, 'committed-wal-run');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('legacy-operation refuses an unkeyed lookalike schema instead of selecting an ambiguous row', async () => {
  const { filePath, db } = fixture();
  db.exec(
    'CREATE TABLE unkeyed AS SELECT * FROM operations; DROP TABLE operations; ALTER TABLE unkeyed RENAME TO operations',
  );
  assert.equal(
    (await lookupLegacyOperation(filePath, expected)).state,
    'incompatible',
  );
});

test('legacy-operation keeps raw native parameter JSON and original digest without rehashing', async () => {
  const raw = ` { "rpcRequestId" : "${rpcRequestId}", "nested": { "keep": [1, null, "value"] } } `;
  const { filePath } = fixture({ native_params: raw });
  const result = await lookupLegacyOperation(filePath, expected);
  assert.equal(result.state, 'found');
  if (result.state !== 'found') return;
  assert.equal(result.operation.nativeParamsJson, raw);
  assert.deepEqual(result.operation.nativeParams, JSON.parse(raw));
  assert.equal(result.operation.requestDigest, expected.requestDigest);
});

test('legacy-operation preserves rejection RPC identity even if native params are absent', async () => {
  const { filePath } = fixture({
    native_params: null,
    launch_rejection: JSON.stringify(rejection()),
    binding: 'unknown',
    run_id: null,
    async_dir: null,
    error: 'rejected',
  });
  const result = await lookupLegacyOperation(filePath, expected);
  assert.equal(result.state, 'found');
  if (result.state !== 'found') return;
  assert.equal(result.operation.launchRejection?.requestId, rpcRequestId);
  assert.equal(result.operation.rpcRequestId, undefined);
});

test('legacy-operation does not initialize an existing empty file', async () => {
  const filePath = location();
  fs.writeFileSync(filePath, '');
  assert.equal(
    (await lookupLegacyOperation(filePath, expected)).state,
    'incompatible',
  );
  assert.equal(fs.statSync(filePath).size, 0);
});

test('legacy-operation rejects incomplete lookup identity without opening storage', async () => {
  const filePath = location();
  for (const field of ['operationId', 'ownerRunId', 'requestDigest']) {
    assert.equal(
      (await lookupLegacyOperation(filePath, { ...expected, [field]: '' }))
        .state,
      'unavailable',
    );
  }
  assert.equal(fs.existsSync(filePath), false);
});
