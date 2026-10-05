import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default async function faultyBridge(pi: ExtensionAPI): Promise<void> {
  const root = process.env.PLAN_EXEC_RECOVERY_SANDBOX;
  const source = process.env.PLAN_EXEC_RECOVERY_BRIDGE;
  if (!root || !source)
    throw new Error('Isolated recovery fixture paths are required.');
  let requestId: string | undefined;
  let dropped = false;
  const events: ExtensionAPI['events'] = {
    emit(channel, data) {
      if (
        !requestId &&
        channel === 'subagents:rpc:v1:request' &&
        existsSync(join(root, 'hold-worker')) &&
        data &&
        typeof data === 'object' &&
        'method' in data &&
        data.method === 'spawn' &&
        'requestId' in data &&
        typeof data.requestId === 'string'
      )
        requestId = data.requestId;
      pi.events.emit(channel, data);
    },
    on(channel, handler) {
      return pi.events.on(channel, (data: unknown) => {
        if (
          !dropped &&
          requestId &&
          channel === `subagents:rpc:v1:reply:${requestId}` &&
          data &&
          typeof data === 'object' &&
          'success' in data &&
          data.success === true
        ) {
          dropped = true;
          writeFileSync(
            join(root, 'lost-reply.json'),
            JSON.stringify({ requestId, dropped }),
          );
          return;
        }
        handler(data);
      });
    },
  };
  const bridge = await import(join(source, 'src/index.ts'));
  await bridge.default({ ...pi, events });
}
