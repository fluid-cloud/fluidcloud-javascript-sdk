import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  // Required: the provider modules are dynamically imported so that an app
  // using one cloud never resolves the other three cloud SDKs. Without
  // splitting, esbuild inlines them and hoists their imports to the top of the
  // ESM bundle, making every provider eager again.
  splitting: true,
});
