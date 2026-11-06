import { ChildProcess, spawn } from 'node:child_process';
import { cpSync } from 'node:fs';

import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src'],
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  format: ['cjs', 'esm'],
  onSuccess: async () => {
    cpSync('src/utils/translations', 'dist/translations', { recursive: true });

    // `tsup --watch` (npm run dev:server): run the fresh build and stop it before the next rebuild.
    // Baileys 7 rc14 loads whatsapp-rust-bridge, which only exports an ESM entry; tsx's CommonJS loader can't
    // resolve it, so development runs the built output with plain node, the same way production does.
    if (options.watch) {
      const server: ChildProcess = spawn(process.execPath, ['dist/main'], { stdio: 'inherit' });
      return () => {
        server.kill();
      };
    }
  },
  loader: {
    '.json': 'file',
    '.yml': 'file',
  },
}));
