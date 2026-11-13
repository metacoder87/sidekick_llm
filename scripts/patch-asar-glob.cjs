// @electron/asar 3.x wraps glob in util.promisify(), which only works with the
// callback-style API from glob 7-11. We override glob to v14 to drop the
// deprecated glob 7 / inflight chain, so call glob's promise API directly.
const fs = require('node:fs');
const path = require('node:path');

const crawlPath = path.join(
  __dirname,
  '..',
  'node_modules',
  '@electron',
  'asar',
  'lib',
  'crawlfs.js',
);

// Dev-only: nothing to patch when production dependencies are installed alone.
if (!fs.existsSync(crawlPath)) {
  process.exit(0);
}

const original = 'const glob = (0, util_1.promisify)(glob_1.glob);';
const patched = 'const glob = glob_1.glob;';
const source = fs.readFileSync(crawlPath, 'utf8');

if (source.includes(patched)) {
  process.exit(0);
}

if (!source.includes(original)) {
  console.error(
    '@electron/asar changed; update scripts/patch-asar-glob.cjs for the installed version.',
  );
  process.exit(1);
}

fs.writeFileSync(crawlPath, source.replace(original, patched));
console.log('Patched @electron/asar to use the modern glob promise API.');
