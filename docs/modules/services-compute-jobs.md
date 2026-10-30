# services/compute-jobs

## Responsibility

Compute jobs (PM-1148): heavy machine work that runs on GitHub Actions and is part of the system, not a loose `gh`
command. The hub knows which jobs a repository may run, starts one on request, records the run and shows what a
local heavy run shows: start, wait, result, log tail and cost. The first job is the cloud image build
([AWS.md](../AWS.md)); PM-1144 is the general workflow, PM-1147 the engine side.

## Setting

`RepoConfig.computeJobs` (`ComputeJobDefinitions` in `packages/shared/src/domain/compute-job.ts`): at most 20
jobs with unique ids; each has `command`, `runsOn`, `outputs`, `node` and `timeoutMinutes`. The limits are the
shared constants the engine registration (`engine-config.ts`) and the engine request (`engine-link/methods.ts`,
`full-test/github-job.ts`) use too.

- The owner sets it with a `repoComputeJobs` patch (a list replaces the jobs of the repository, `null` removes
  them). The change is owner-only (`compute_jobs`): the commands run on GitHub with the right to attest their
  outputs. The Operator needs an approval.
- Invariant `compute_jobs_github`: a repository with compute jobs needs a `github` owner/name.
- The engine runs a job only when its own `engine.json` registers it with the same values (PM-1147); the hub's
  setting is what the hub asks for, not what grants the right.

## Run record

Table `compute_job_runs` (migration 133), `ComputeJobRunView` in the shared package: the job, repository, commit,
runner (`github_actions`; `engine` is reserved), status (`queued`, `running`, `succeeded`, `failed`, `error`,
`cancelled`) and reason, who asked, the optional card, times, queue wait, run time, billable time, the run link,
the log tail (4000 characters), the declared outputs with digests and the artifact with its expiry.

At startup `init()` ends the runs left unfinished as `cancelled`/`interrupted`; `stop()` aborts the running ones
(`cancelled`/`shutdown`).

## Starting a run

`ComputeJobService.start` (the `run_compute_job` tool). In this order it:

1. checks access: the `deployment` duty, or an integrator that holds the owner's authority (the external endpoint
   in super mode);
2. finds the repository and the job (`compute_job_unknown`) and the optional card (`not_found`); a repository
   without `github` is refused (`release_no_github`);
3. asks the project engine whether the commit is on the remote default branch (`compute_job_commit_unpublished`;
   a lost link or no merger: `engine_offline`);
4. in one unit of work returns the live run of the same commit (queued, running, or succeeded with an artifact
   that has not expired) unless `force`, refuses a third active run in the installation (`compute_job_busy`,
   `COMPUTE_JOBS_MAX`), and inserts the `queued` row;
5. answers with the queued run and goes on in the background: `FullTestExecutor.run` on the project engine with
   the `githubJob` descriptor (the same `full_test.run` the merge check uses). The row turns `running` when the
   run starts and is filled in at the end; an engine refusal becomes `error`/`engine_refused`. With `task_key` a
   `task_note` as the system goes on the card at the end.

The workflow itself runs only a commit that is on the default branch (`projectman-job.yml`: a full checkout and
`git merge-base --is-ancestor` before `Run`).

## Tools

`run_compute_job`, `get_compute_job`, `list_compute_jobs` (`mcp/compute-jobs/`): visible to the `deployment` duty
and bound to the integrator on the external endpoint (`run` in super mode only, the readers in `read` too).

## Machine dependence

The hub part is machine-independent: it needs only the project engine's `merger` and `fullTestExecutor`. The
GitHub access (`gh` login) stays on the engine. See "GitHub Actions runs (merge check, compute jobs)" in
[MACHINE-DEPENDENT.md](../MACHINE-DEPENDENT.md).
