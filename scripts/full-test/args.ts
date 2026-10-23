interface FullTestArgs {
  workers: number;
  timeoutMinutes: number;
  command: string[];
}

export function parseFullTestArgs(argv: readonly string[]): FullTestArgs {
  const result: FullTestArgs = { workers: 4, timeoutMinutes: 60, command: [] };
  let index = 0;
  while (index < argv.length && argv[index] !== '--') {
    const option = argv[index++];
    if (option !== '--workers' && option !== '--timeout') throw new Error(`unknown option ${option}`);
    const raw = argv[index++];
    const value = Number(raw);
    const max = option === '--workers' ? 8 : 60;
    if (!raw || !/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`${option} needs an integer from 1 to ${max}`);
    if (option === '--workers') result.workers = value;
    else result.timeoutMinutes = value;
  }
  if (argv[index] !== '--' || index + 1 === argv.length) throw new Error('a command after -- is required');
  result.command = argv.slice(index + 1);
  return result;
}
