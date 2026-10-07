import type { EventBus } from './rpc.js';
import { NATIVE_REVIEWER_AGENT } from './types.js';

const registrations = new WeakMap<EventBus, { dispose(): void }>();

/** Only a successful, undisposed registration owned by this extension qualifies. */
export function hasNativeReviewerRegistration(events: EventBus): boolean {
  return registrations.has(events);
}

/** Public runtime-agent registration. No model pin or writable tools. */
export function registerNativeReviewer(events: EventBus): { dispose(): void } {
  const request: {
    version: 1;
    name: string;
    definition: {
      description: string;
      systemPrompt: string;
      tools: string[];
      skills: string[];
      inheritSkills: false;
    };
    result?:
      | { ok: true; registration: { dispose(): void } }
      | { ok: false; error: Error };
  } = {
    version: 1,
    name: NATIVE_REVIEWER_AGENT,
    definition: {
      description:
        'Read-only, commit-bound plan execution reviewer and statistics reporter.',
      systemPrompt:
        'Inspect the requested source and evidence without modifying files. For review, return only the requested JSON schema with the exact reviewed commit and concrete findings. Do not invent evidence or a verdict. Report unavailable evidence as a finding. For statistics, report only observed facts.',
      tools: ['read', 'grep', 'find', 'ls'],
      skills: [],
      inheritSkills: false,
    },
  };
  events.emit('pi-subagents:runtime-agent-register:v1', request);
  if (!request.result)
    throw new Error(
      'Native reviewer registration unavailable: pi-subagents is not ready.',
    );
  if (!request.result.ok) throw request.result.error;
  const upstream = request.result.registration;
  const registration = {
    dispose() {
      if (registrations.get(events) === registration)
        registrations.delete(events);
      upstream.dispose();
    },
  };
  registrations.set(events, registration);
  return registration;
}
