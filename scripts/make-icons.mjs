// Optional asset-generation step; generated PNGs are included in the extension.
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require(process.env.SHARP_MODULE ? resolve(process.env.SHARP_MODULE) : 'sharp');
  if (typeof sharp !== 'function') throw new Error('The selected module does not export the Sharp image function.');
} catch (error) {
  throw new Error('Unable to load Sharp. Run "npm install --no-save sharp" in the source checkout, or set SHARP_MODULE to the path of the installed sharp package or its entry file. ' + error.message, { cause: error });
}
const directory = fileURLToPath(new URL('../icons/', import.meta.url));
for (const size of [16, 32, 48, 128]) {
  await sharp(join(directory, 'mark.svg')).resize(size, size).png().toFile(join(directory, `icon-${size}.png`));
}
console.log('Generated toolbar and extension icons.');
