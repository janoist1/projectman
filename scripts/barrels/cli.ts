import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BARRELS, generateBarrel } from './generate';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const directory of BARRELS) {
  writeFileSync(join(root, directory, 'index.ts'), generateBarrel(root, directory));
}
