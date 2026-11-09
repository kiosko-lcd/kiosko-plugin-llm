// Bundles the plugin into dist/index.js. What Kiosko itself provides to
// every plugin (the SDK, the drawing kit, the canvas) stays external: the
// host resolves those imports to its own copies at load time.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['source'],
  external: ["@kiosko/sdk","@loksly/lcd-canvas-kit","@loksly/weather-astro","@napi-rs/canvas"],
  legalComments: 'linked',
  banner: { js: "import { createRequire as __pluginRequire } from 'node:module'; const require = __pluginRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log('dist/index.js');
