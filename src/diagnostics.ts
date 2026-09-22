import { createHash } from 'node:crypto';

const MAX_LABEL_LENGTH = 256;
const MAX_DETAIL_LENGTH = 1_200;
const MAX_PID = 2_147_483_647;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export interface ToolFailureEvidence {
  kind: 'tool-execution-error';
  toolCallId: string;
  toolName: string;
  observedAt: number;
  message: string;
}

export interface OperationActivity {
  phase?: string;
  state?: string;
  currentTool?: string;
  toolCallId?: string;
  currentToolStartedAt?: number;
  lastActivityAt?: number;
  lastModelActivityAt?: number;
  lastToolActivityAt?: number;
  runnerPid?: number;
  recentFailureSummary?: string;
  lastToolFailure?: ToolFailureEvidence;
}

export interface OperationDiagnostics extends OperationActivity {
  observedAt: number;
  nextProbeAt: number;
  assessment:
    | 'observing'
    | 'tool_fault_reported'
    | 'exit_confirmed'
    | 'status_unavailable';
  action: 'probe' | 'repair_tool' | 'reconcile';
  failureKey?: string;
  error?: string;
}

interface DiagnosisOptions {
  now: number;
  nextProbeAt: number;
  treeExited: boolean;
  prior?: OperationDiagnostics;
  statusUnavailable?: boolean;
  error?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function label(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_LABEL_LENGTH
    ? trimmed
    : undefined;
}

function detail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().slice(0, MAX_DETAIL_LENGTH) || undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_TIMESTAMP
    ? value
    : undefined;
}

function toolFailure(value: unknown): ToolFailureEvidence | undefined {
  const source = record(value);
  if (source?.kind !== 'tool-execution-error') return undefined;
  const toolCallId = label(source.toolCallId);
  const toolName = label(source.toolName);
  const observedAt = timestamp(source.observedAt);
  const message = detail(source.message);
  return toolCallId && toolName && observedAt && message
    ? {
        kind: 'tool-execution-error',
        toolCallId,
        toolName,
        observedAt,
        message,
      }
    : undefined;
}

export function parseOperationActivity(
  activity: unknown,
  status?: unknown,
): OperationActivity {
  const source = record(activity) ?? {};
  const envelope = record(status) ?? {};
  const parsed: OperationActivity = {};
  for (const key of ['phase', 'state', 'currentTool', 'toolCallId'] as const) {
    const value = label(source[key]);
    if (value) parsed[key] = value;
  }
  for (const key of [
    'currentToolStartedAt',
    'lastActivityAt',
    'lastModelActivityAt',
    'lastToolActivityAt',
  ] as const) {
    const value = timestamp(source[key]);
    if (value) parsed[key] = value;
  }
  const pid = source.runnerPid ?? envelope.runnerPid;
  if (
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    pid <= MAX_PID
  )
    parsed.runnerPid = pid;
  const summary = detail(source.recentFailureSummary);
  if (summary) parsed.recentFailureSummary = summary;
  const failure = toolFailure(source.lastToolFailure);
  if (failure) parsed.lastToolFailure = failure;
  return parsed;
}

/** Activity describes a phase; only separately validated ownership can prove exit. */
export function diagnoseOperation(
  activity: unknown,
  status: unknown,
  options: DiagnosisOptions,
): OperationDiagnostics {
  const parsed =
    options.statusUnavailable && options.prior
      ? parseOperationActivity(options.prior)
      : parseOperationActivity(activity, status);
  const failure =
    parsed.lastToolFailure ?? toolFailure(options.prior?.lastToolFailure);
  if (failure) parsed.lastToolFailure = failure;
  const assessment = options.treeExited
    ? 'exit_confirmed'
    : options.statusUnavailable
      ? 'status_unavailable'
      : failure
        ? 'tool_fault_reported'
        : 'observing';
  const action = options.treeExited
    ? 'reconcile'
    : !options.statusUnavailable && failure
      ? 'repair_tool'
      : 'probe';
  const error = detail(options.error);
  return {
    ...parsed,
    observedAt: options.now,
    nextProbeAt: options.nextProbeAt,
    assessment,
    action,
    ...(failure
      ? {
          failureKey: createHash('sha256')
            .update(
              JSON.stringify([
                failure.kind,
                failure.toolCallId,
                failure.toolName,
                failure.observedAt,
              ]),
            )
            .digest('hex'),
        }
      : {}),
    ...(error ? { error } : {}),
  };
}
