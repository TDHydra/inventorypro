// Returns the message of the error thrown by fn(), or throws if nothing was thrown.
export function expectThrows(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected fn to throw, but it did not');
}
