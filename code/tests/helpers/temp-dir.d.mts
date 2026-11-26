import type { TestContext } from 'node:test'
export function tempDir(t: TestContext, prefix: string, base?: string): Promise<string>
