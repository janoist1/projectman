import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// macOS alone does not imply APFS: hosted runners can put TMPDIR on another filesystem.
// Match the dependency cloner's volume requirement; real clone failures on APFS still fail tests.
export const hasApfsTemporaryFilesystem = process.platform === 'darwin' && statfsSync(tmpdir()).type === 26;
