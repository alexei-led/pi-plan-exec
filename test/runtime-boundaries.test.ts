import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const productionRoot = join(process.cwd(), 'src');
const privateNativeSpecifier = /^pi-subagents\/src(?:\/|$)/;
const importSpecifierPattern =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function privateNativeImports(source: string): string[] {
  return [...source.matchAll(importSpecifierPattern)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => typeof specifier === 'string')
    .filter((specifier) => privateNativeSpecifier.test(specifier));
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(?:ts|js|mjs)$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

test('native boundary guard rejects private native imports and accepts public subpaths', async () => {
  const testFixture = `import { registerSubagentRpcBridge } from 'pi-subagents/src/extension/rpc.js';`;
  expect(privateNativeImports(testFixture)).toEqual([
    'pi-subagents/src/extension/rpc.js',
  ]);
  expect(
    privateNativeImports(
      `import { resolveSubagentLaunchContract } from 'pi-subagents/preflight';`,
    ),
  ).toEqual([]);
  expect(
    privateNativeImports(
      `import { registerExternalRun } from 'pi-subagents/external-runs';`,
    ),
  ).toEqual([]);

  for (const source of [
    `import 'pi-subagents/src/extension/rpc.js';`,
    `require('pi-subagents/src/extension/rpc.js');`,
    `import('pi-subagents/src/extension/rpc.js');`,
  ]) {
    expect(privateNativeImports(source)).toEqual([
      'pi-subagents/src/extension/rpc.js',
    ]);
  }

  const files = await sourceFiles(productionRoot);
  const violations = [];
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    for (const specifier of privateNativeImports(source))
      violations.push(`${path}: private import ${specifier}`);
  }
  expect(violations).toEqual([]);
});
