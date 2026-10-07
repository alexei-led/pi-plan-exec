import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Isolated public-event fault injection; never loads or emulates another runtime. */
export default function faultyNative(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  const root = process.env.PLAN_EXEC_RECOVERY_SANDBOX;
  if (!root) throw new Error('An isolated recovery sandbox is required.');
  let pending: string | undefined;
  const emit = pi.events.emit.bind(pi.events);
  pi.events.emit = (channel, value) => {
    if (
      channel === 'subagents:rpc:v1:request' &&
      existsSync(join(root, 'drop-next-reply')) &&
      value &&
      typeof value === 'object' &&
      'method' in value &&
      value.method === 'spawn' &&
      'requestId' in value &&
      typeof value.requestId === 'string'
    ) {
      pending = value.requestId;
      unlinkSync(join(root, 'drop-next-reply'));
    }
    if (pending && channel === `subagents:rpc:v1:reply:${pending}`) {
      writeFileSync(
        join(root, 'lost-reply.json'),
        JSON.stringify({ requestId: pending, dropped: true }),
      );
      pending = undefined;
      return;
    }
    emit(channel, value);
  };
}
