import { expect, test } from 'vitest';
import {
  hasNativeReviewerRegistration,
  registerNativeReviewer,
} from '../src/native-reviewer.js';
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
        definition: {
          tools: string[];
          model?: string;
          skills: string[];
          inheritSkills: boolean;
        };
        result?: unknown;
      };
      expect(request.name).toBe(DEFAULT_FROZEN_RUN_CONFIG.reviewerAgent);
      expect(request.definition.tools).toEqual(['read', 'grep', 'find', 'ls']);
      expect(request.definition.model).toBeUndefined();
      expect(request.definition.skills).toEqual([]);
      expect(request.definition.inheritSkills).toBe(false);
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

test('owned reviewer registration is scoped to its event bus and revoked by disposal or failed registration', () => {
  const events = {
    on() {
      return () => {};
    },
    emit(_name: string, value: unknown) {
      (value as { result?: unknown }).result = {
        ok: true,
        registration: { dispose() {} },
      };
    },
  };
  expect(hasNativeReviewerRegistration(events)).toBe(false);
  const role = registerNativeReviewer(events);
  expect(hasNativeReviewerRegistration(events)).toBe(true);
  expect(hasNativeReviewerRegistration({ ...events })).toBe(false);
  role.dispose();
  expect(hasNativeReviewerRegistration(events)).toBe(false);
  events.emit = (_name, value) => {
    (value as { result?: unknown }).result = {
      ok: false,
      error: new Error('registration failed'),
    };
  };
  expect(() => registerNativeReviewer(events)).toThrow('registration failed');
  expect(hasNativeReviewerRegistration(events)).toBe(false);
});
