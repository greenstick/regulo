import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'node20',
  dts: true,
  clean: true,
  minify: true,
  treeshake: true,
  sourcemap: true,
  esbuildOptions (options) {
    options.banner = {};
    options.footer = {};
    options.legalComments = 'none';
    options.minifyWhitespace = true;
    options.minifyIdentifiers = true;
    options.minifySyntax = true;
    options.keepNames = false;
    return options;
  },
});
