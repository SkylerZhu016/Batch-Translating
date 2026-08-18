import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import viteConfig from './vite.config';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// The root Vitest workspace discovers `vitest.config.ts` files for directory
// projects. Merge the app's Vite config explicitly so Vue, virtual Remix icons,
// and the local Kimi icon collection use the same transforms in root and
// package-scoped test runs.
export default mergeConfig(
  viteConfig,
  defineConfig({
    root: projectRoot,
    test: {
      name: 'batch-translating-web',
    },
  }),
);
