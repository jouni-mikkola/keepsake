// Copies the three third-party libraries from node_modules into src/vendor.
// The copies are committed so the extension can be loaded without a build step.
import { copyFileSync, mkdirSync } from 'node:fs';

const files = {
  'node_modules/mux.js/dist/mux.min.js': 'src/vendor/mux.min.js',
  'node_modules/dompurify/dist/purify.min.js': 'src/vendor/purify.min.js',
  'node_modules/@mozilla/readability/Readability.js': 'src/vendor/Readability.js',
};
mkdirSync('src/vendor', { recursive: true });
for (const [from, to] of Object.entries(files)) {
  copyFileSync(from, to);
  console.log(`${from} -> ${to}`);
}
