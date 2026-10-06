/** Untrusted display telemetry. Never use this as worker progress or retirement evidence. */
export interface AdvisoryObservation {
  version: 1;
  source: 'pi-subagents.async-status-snapshot';
  runId: string;
  generatedAt: number;
  activity?: {
    state?: string;
    currentTool?: string;
    lastActivityAt?: number;
    currentToolStartedAt?: number;
    turnCount?: number;
    toolCount?: number;
  };
  omitted: { runs: number; children: number; byteLimitExceeded: boolean };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function parseAdvisoryObservation(
  value: unknown,
  runId: string | undefined,
  now: number,
): AdvisoryObservation | undefined {
  if (
    !runId ||
    !record(value) ||
    value.version !== 1 ||
    value.source !== 'pi-subagents.async-status-snapshot' ||
    value.runId !== runId ||
    !count(value.generatedAt) ||
    value.generatedAt > now ||
    now - value.generatedAt > 30_000 ||
    !record(value.omitted) ||
    !count(value.omitted.runs) ||
    !count(value.omitted.children) ||
    typeof value.omitted.byteLimitExceeded !== 'boolean'
  )
    return undefined;
  const activity: NonNullable<AdvisoryObservation['activity']> = {};
  if (value.activity !== undefined) {
    if (!record(value.activity)) return undefined;
    for (const key of ['state', 'currentTool'] as const) {
      const text = value.activity[key];
      if (text === undefined) continue;
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 160 ||
        /[\p{Cc}\p{Cf}]/u.test(text)
      )
        return undefined;
      activity[key] = text;
    }
    for (const key of [
      'lastActivityAt',
      'currentToolStartedAt',
      'turnCount',
      'toolCount',
    ] as const) {
      const number = value.activity[key];
      if (number === undefined) continue;
      if (
        !count(number) ||
        ((key === 'lastActivityAt' || key === 'currentToolStartedAt') &&
          number > value.generatedAt)
      )
        return undefined;
      activity[key] = number;
    }
  }
  return {
    version: 1,
    source: value.source,
    runId,
    generatedAt: value.generatedAt,
    ...(Object.keys(activity).length ? { activity } : {}),
    omitted: {
      runs: value.omitted.runs,
      children: value.omitted.children,
      byteLimitExceeded: value.omitted.byteLimitExceeded,
    },
  };
}
