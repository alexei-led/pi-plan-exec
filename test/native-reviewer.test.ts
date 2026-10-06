import { expect, test } from 'vitest';
import { registerNativeReviewer } from '../src/native-reviewer.js';
import { DEFAULT_FROZEN_RUN_CONFIG } from '../src/types.js';

test('default readonly reviewer registration uses public events and disposes without model substitution', () => {
  let disposed = false;
  const registration = registerNativeReviewer({
    on() {
      return () => {};
    },
    emit(name, value) {
      expect(name).toBe('pi-subagents:runtime-agent-register:v1');
      const request = value as {
        name: string;
        definition: { tools: string[]; model?: string };
        result?: unknown;
      };
      expect(request.name).toBe(DEFAULT_FROZEN_RUN_CONFIG.reviewerAgent);
      expect(request.definition.tools).toEqual(['read', 'grep', 'find', 'ls']);
      expect(request.definition.model).toBeUndefined();
      request.result = {
        ok: true,
        registration: {
          dispose() {
            disposed = true;
          },
        },
      };
    },
  });
  registration.dispose();
  expect(disposed).toBe(true);
});

test('missing native runtime owner is an explicit registration failure', () => {
  expect(() =>
    registerNativeReviewer({
      on() {
        return () => {};
      },
      emit() {},
    }),
  ).toThrow(/unavailable/);
});
