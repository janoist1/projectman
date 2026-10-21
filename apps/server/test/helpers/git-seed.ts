import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Build once per file, then copy independent real repositories without repeating git setup. */
export function createGitSeed(
  root: string,
  files: Record<string, string>,
  identity: { name: string; email: string } | false = {
    name: 'projectman test',
    email: 'test@example.com',
  },
) {
  const repo = path.join(root, 'repo');
  const bare = path.join(root, 'remote.git');
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  if (identity) {
    git('config', 'user.name', identity.name);
    git('config', 'user.email', identity.email);
  }
  git('config', 'commit.gpgsign', 'false');
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
  }
  git('add', '-A');
  git('-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-q', '-m', 'Initial commit');
  const commit = git('rev-parse', 'HEAD');
  git('clone', '-q', '--bare', '--no-hardlinks', repo, bare);
  return {
    commit,
    copyTo(target: string, remote?: string) {
      cpSync(repo, target, { recursive: true });
      if (remote) {
        cpSync(bare, remote, { recursive: true });
        const config = path.join(target, '.git', 'config');
        writeFileSync(
          config,
          `${readFileSync(config, 'utf8')}\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`,
        );
        // Match a clone/push setup, including its remote-tracking branch.
        mkdirSync(path.join(target, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
        writeFileSync(path.join(target, '.git', 'refs', 'remotes', 'origin', 'main'), `${commit}\n`);
      }
    },
  };
}
