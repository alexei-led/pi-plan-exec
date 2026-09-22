/**
 * Assert that a value the surrounding code has already established is
 * present. Throwing here names the invariant instead of failing later with an
 * unrelated read of `undefined`.
 */
export function required<T>(
  value: T | null | undefined,
  message = 'Expected a defined value',
): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
