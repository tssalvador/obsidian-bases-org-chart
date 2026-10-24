// Minimal types for the parts of Node's test runner the tests use, so the
// project doesn't need @types/node.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, error?: abstract new (...args: never[]) => Error, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
