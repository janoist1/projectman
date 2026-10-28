import { dutyMembers, isReleaseTagName, RELEASE_TAG_PATTERN, releaseTagName } from '@projectman/shared';
import type { EngineId, ProjectConfig, TaskKey } from '@projectman/shared';
import { MergeError } from '../../contracts';
import type { BranchMerger, EngineDirectory, GithubService, PublishedRelease } from '../../contracts';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import { conflict, forbidden, invalid, KeyedMutex, newId } from '../../kernel';
import { landedCards, landedMerges, resolveLandedCommit } from './landed-cards';

type RepoConfig = ProjectConfig['project']['repos'][number];

/** The most cards listed in the notes; the rest is counted. */
const MAX_NOTE_CARDS = 100;
/** A card title is cut here in the notes, so the notes stay under the limit of the GitHub call. */
const MAX_NOTE_TITLE = 120;

export interface PublishReleaseInput {
  /** English markdown: the start of the release notes. */
  summary: string;
  /** The repository's name; absent: the project's only repository. */
  repo?: string | undefined;
  /** A merge commit of a card; absent: the head of the default branch. */
  commit?: string | undefined;
  /** The tag; absent: the tag of the commit if it has one, else the next free date tag. */
  tag?: string | undefined;
}

type Deps = {
  ctx: DomainContext;
  projects: ProjectService;
  engines: EngineDirectory;
  /** The GitHub access of the machine that runs `gh` (on the cloud server: the default engine). */
  github: Pick<GithubService, 'publishRelease'>;
  /** The engine that holds the repository for the member's work. */
  engineId: (projectKey: string, member: string) => EngineId;
};

/**
 * `publish_release` (PM-968): the member with the deployment duty tags a merged commit and makes its public
 * GitHub release. No approval and no deployment; the project's own deploy and `propose_release` are separate.
 * The tag is made on the engine that holds the repository, the release on the engine of `gh`. A publication
 * is recorded when the tag is on the remote and completed when the release exists, so a call repeated after
 * an interruption goes on from where it stopped.
 */
export class ReleasePublishService {
  private readonly deps: Deps;
  private readonly locks = new KeyedMutex();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** What `publish` would do, with nothing recorded and nothing sent. */
  preview(projectKey: string, by: string, input: PublishReleaseInput): Promise<PublishedRelease> {
    return this.run(projectKey, by, input, false);
  }

  publish(projectKey: string, by: string, input: PublishReleaseInput): Promise<PublishedRelease> {
    return this.run(projectKey, by, input, true);
  }

  private async run(
    projectKey: string,
    by: string,
    input: PublishReleaseInput,
    write: boolean,
  ): Promise<PublishedRelease> {
    if (input.tag !== undefined && !isReleaseTagName(input.tag))
      throw invalid('invalid_request', `"${input.tag}" is not a valid tag name`);
    const config = await this.deps.projects.config(projectKey);
    this.requireDutyHolder(config, by);
    const repo = this.repoOf(config, input.repo);
    if (!repo.github)
      throw conflict('release_no_github', `repository ${repo.name} has no GitHub repository configured`);
    return this.locks.run(`${projectKey}/${repo.name}`, () =>
      this.runLocked({ projectKey, by, input, write, repo, github: repo.github! }),
    );
  }

  private requireDutyHolder(config: ProjectConfig, by: string): void {
    if (!dutyMembers(config, 'deployment').some((member) => member.handle === by))
      throw forbidden('insufficient_access', 'only a member with the deployment duty may publish a release');
  }

  private repoOf(config: ProjectConfig, name: string | undefined): RepoConfig {
    const { repos } = config.project;
    if (name === undefined) {
      if (repos.length === 1) return repos[0]!;
      throw invalid('invalid_request', 'repo is required when the project has several repositories');
    }
    const repo = repos.find((entry) => entry.name === name);
    if (!repo) throw invalid('invalid_request', `the project has no repository ${name}`);
    return repo;
  }

  private merger(projectKey: string, by: string): BranchMerger {
    const engine = this.deps.engines.get(this.deps.engineId(projectKey, by));
    if (!engine?.merger)
      throw conflict('engine_offline', 'the engine that holds the repository is not connected');
    return engine.merger;
  }

  /** A failed git step of the engine, in the words of the tool. */
  private async gitStep<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof MergeError)
        throw conflict('release_publish_failed', `the tag step failed: ${err.message}`, {
          step: 'tag',
          reason: err.code,
        });
      throw err;
    }
  }

  private async runLocked(input: {
    projectKey: string;
    by: string;
    input: PublishReleaseInput;
    write: boolean;
    repo: RepoConfig;
    github: string;
  }): Promise<PublishedRelease> {
    const { projectKey, by, repo, write } = input;
    const { ctx } = this.deps;
    const publications = ctx.repos.releasePublications;
    const ref = { projectKey, repo: repo.name };
    const merger = this.merger(projectKey, by);
    const landed = landedMerges(ctx.repos.taskMerges.mergedOf(projectKey, repo.name));
    const commit = await resolveLandedCommit({
      merger,
      ref,
      landed,
      commit: input.input.commit,
      defaultBranch: async () => repo.defaultBranch,
    });
    const existing = publications.byCommit(projectKey, repo.name, commit);
    if (existing?.url)
      throw conflict('release_already_published', `${commit} was published as ${existing.tag}`, {
        tag: existing.tag,
        url: existing.url,
      });
    const baseCommit = existing ? existing.baseCommit : this.baseOf(projectKey, repo.name);
    // An interrupted publication keeps the cards it recorded.
    const keys = existing
      ? (existing.tasks as TaskKey[])
      : await landedCards({ merger, ref, landed, commit, baseCommit });
    const tasks = keys.map((key) => ({ key, title: ctx.repos.tasks.get(key)?.title ?? key }));
    const remote = await this.gitStep(() => merger.remoteTags(ref, { base: repo.defaultBranch }));
    const tag = this.chooseTag(projectKey, repo.name, commit, remote, existing?.tag, input.input.tag);
    const result: PublishedRelease = { repo: repo.name, commit, baseCommit, tag, url: null, tasks };
    if (!write) return result;

    // The authority is checked again where the writes begin: the engine calls above take a while.
    this.requireDutyHolder(await this.deps.projects.config(projectKey), by);
    if (!remote.some((entry) => entry.name === tag)) {
      const pushed = await this.gitStep(() => merger.pushTag(ref, { base: repo.defaultBranch, tag, commit }));
      if (!pushed.ok)
        throw conflict('release_publish_failed', `the tag could not be pushed: ${pushed.message}`, {
          step: 'tag',
          reason: pushed.reason,
        });
    }
    const summary = existing ? existing.summary : input.input.summary.trim();
    let row = existing;
    if (!row) {
      row = {
        id: newId('rpub'),
        projectKey,
        repo: repo.name,
        commit,
        baseCommit,
        tag,
        tasks: keys,
        summary,
        publishedBy: by,
        taggedAt: isoNow(ctx),
        url: null,
        publishedAt: null,
      };
      const inserted = row;
      ctx.unitOfWork(() => publications.insert(inserted));
    }
    let url: string;
    try {
      ({ url } = await this.deps.github.publishRelease(projectKey, input.github, {
        tag,
        title: tag,
        notes: releaseNotes(summary, tasks, commit),
      }));
    } catch (err) {
      throw conflict(
        'release_publish_failed',
        `the tag ${tag} is pushed, the GitHub release failed: ${err instanceof Error ? err.message : String(err)}. Call publish_release again to finish it.`,
        { step: 'github', tag },
      );
    }
    const releaseRow = row;
    ctx.unitOfWork(() => publications.markPublished(releaseRow.id, url, isoNow(ctx)));
    return { ...result, url };
  }

  /** The commit the previous release ended at: the last published one, else the last live release of the instance. */
  private baseOf(projectKey: string, repo: string): string | null {
    const { repos } = this.deps.ctx;
    const published = repos.releasePublications.latestPublished(projectKey, repo);
    if (published) return published.commit;
    const live = repos.releases.latestLive(projectKey);
    return live && live.repo === repo ? live.commit : null;
  }

  /**
   * The tag, in this order: the one of the interrupted publication, the one asked for, one the remote already
   * has on this commit, the next free date tag. A tag that is somewhere else already is `release_tag_taken`.
   */
  private chooseTag(
    projectKey: string,
    repo: string,
    commit: string,
    remote: readonly { name: string; commit: string }[],
    recorded: string | undefined,
    asked: string | undefined,
  ): string {
    if (recorded && asked && asked !== recorded)
      throw conflict('release_tag_taken', `this commit is tagged ${recorded} already`, {
        tag: recorded,
        commit,
      });
    const tag =
      recorded ??
      asked ??
      remote.find((entry) => RELEASE_TAG_PATTERN.test(entry.name) && entry.commit === commit)?.name ??
      releaseTagName(
        this.deps.ctx.now(),
        remote.map((entry) => entry.name),
      );
    const there = remote.find((entry) => entry.name === tag);
    if (there && there.commit !== commit)
      throw conflict('release_tag_taken', `tag ${tag} is on another commit`, { tag, commit: there.commit });
    const other = this.deps.ctx.repos.releasePublications.byTag(projectKey, repo, tag);
    if (other && other.commit !== commit)
      throw conflict('release_tag_taken', `tag ${tag} belongs to another publication`, {
        tag,
        commit: other.commit,
      });
    return tag;
  }
}

/** The text of the GitHub release: the summary, the merged cards, the commit. */
function releaseNotes(
  summary: string,
  tasks: readonly { key: string; title: string }[],
  commit: string,
): string {
  const cards = tasks
    .slice(0, MAX_NOTE_CARDS)
    .map((task) => `- ${task.key} ${task.title.slice(0, MAX_NOTE_TITLE)}`);
  if (tasks.length > MAX_NOTE_CARDS) cards.push(`- … and ${tasks.length - MAX_NOTE_CARDS} more`);
  return [summary, '', '## Cards', ...cards, '', `Commit: ${commit}`].join('\n');
}
