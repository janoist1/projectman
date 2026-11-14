// Renumbers the migrations a branch added after the newest migration of a base revision (PM-1496).
//
//   npm run migrations:renumber -- --base <rev>
//
// The merge runs it through `npm run merge:regenerate` with `--base HEAD^1`; after merging main a developer
// runs it with `--base main`. Exit status: 0 done, 1 refused (nothing written), 2 wrong usage.
import { fileURLToPath } from 'node:url';
import { RenumberRefused, renumberMigrations } from './renumber';

const args = process.argv.slice(2);
const base = args[0] === '--base' && args.length === 2 ? args[1] : undefined;
if (!base) {
  console.error('Usage: npm run migrations:renumber -- --base <rev>');
  process.exit(2);
}
try {
  for (const line of renumberMigrations(fileURLToPath(new URL('../../', import.meta.url)), base))
    console.log(line);
} catch (error) {
  if (!(error instanceof RenumberRefused)) throw error;
  console.error(error.message);
  process.exit(1);
}
