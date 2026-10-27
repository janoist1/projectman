import { regeneratedWriteDirs, type ReviewTestConfig } from '@projectman/shared';
import { EngineLinkLostError, isEngineLinkLost } from '../../contracts';
import type { EngineHost, MergeBuildResult, MergeRepoRef } from '../../contracts';
import { newId, SYSTEM_ACTOR } from '../../kernel';
import type { MergeDeps } from './deps';
import { mergeCheckExecutor, prepareMergeCheck } from './check-preparation';

/**
 * Generated files that a conflicting merge makes again (PM-1050). A merge that conflicts only in files
 * matching `reviewTest.regenerate.paths` runs the configured command on the merge result without those files,
 * in the full test sandbox of the card's engine, in a checkout of its own, and commits what it wrote there.
 * The merge check then checks that commit as always, in the merge's own checkout. Any other conflict, and any failure here, is the conflict the merge
 * failed with before.
 */

interface RegenerateInput {
  deps: Pick<MergeDeps, 'timeline' | 'checkSandbox'>;
  engine: EngineHost;
  ref: MergeRepoRef;
  mergeId: string;
  taskKey: string;
  projectKey: string;
  base: string;
  reviewTest: ReviewTestConfig;
  /** The inputs of the merge `build` that conflicted. */
  build: { onto: string; commit: string; message: string };
  conflict: readonly string[];
  depsFrom: string | null;
  signal: AbortSignal;
  /** The merge's checkpoint (`MergeSteps.continue`): false once the merge must not go on. */
  proceed: () => boolean;
}

export type RegenerateResult =
  | { ok: true; built: Extract<MergeBuildResult, { ok: true }> }
  /** `detail`: why the files were not made again, when it is more than "the conflict is in code". */
  | { ok: false; detail?: string }
  | { stopped: true };

/** The system note of a merge that made its conflicting generated files again. */
function regeneratedNote(command: string, files: readonly string[]): string {
  return `Merge conflict only in generated files (${files.join(', ')}): made again with "${command}" on the merge result. The merge check verifies the result.`;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : 'regeneration failed');

export async function regenerateConflict(input: RegenerateInput): Promise<RegenerateResult> {
  const { engine, ref, reviewTest, proceed } = input;
  const { regenerate } = reviewTest;
  const merger = engine.merger;
  if (!regenerate || !merger) return { ok: false };
  let again: MergeBuildResult;
  try {
    again = await merger.build(ref, { ...input.build, regenerate: regenerate.paths });
  } catch (err) {
    if (isEngineLinkLost(err)) throw err;
    // An engine from before this feature refuses the field: the merge goes the way it always went.
    return proceed() ? { ok: false, detail: messageOf(err) } : { stopped: true };
  }
  if (!proceed()) return { stopped: true };
  if (again.ok || again.provisional === undefined) return { ok: false };
  // The command may write only the directories the patterns name, nothing else of the checkout.
  if (regeneratedWriteDirs(regenerate.paths) === null)
    return { ok: false, detail: 'a generated path pattern names no directory to write' };
  // The generator runs on the engine whatever runs the merge check: GitHub Actions cannot write back.
  const available = await mergeCheckExecutor(engine, 'engine');
  if (!available.ok) return { ok: false, detail: available.reason };
  if (!proceed()) return { stopped: true };
  // The run has a checkout of its own: a process it leaves behind can never write into the merge check's.
  const regenId = newId('merge');
  try {
    // Not a merge check: it is not recorded among the check runs.
    const prepared = await prepareMergeCheck(merger, {
      ref,
      mergeId: regenId,
      mergeCommit: again.provisional,
      base: input.base,
      depsFrom: input.depsFrom,
      runner: 'engine',
      github: undefined,
      checkSandbox: input.deps.checkSandbox,
      paths: engine.paths(),
    });
    if (!proceed()) return { stopped: true };
    const spec = prepared.spec({ runId: newId('regen'), command: regenerate.command, reviewTest });
    const result = await available.executor.run(
      { ...spec, regenerate: { ref, mergeId: regenId, patterns: regenerate.paths } },
      input.signal,
    );
    if (!proceed()) return { stopped: true };
    if (result.outcome === 'error' && result.reason === 'engine_offline')
      throw new EngineLinkLostError('the regeneration lost the card engine', true);
    if (result.outcome !== 'passed')
      return { ok: false, detail: result.outputTail.slice(-4000) || `the command ${result.outcome}` };
    const committed = await merger.commitRegenerated(ref, {
      mergeId: regenId,
      ...input.build,
      message: `${input.build.message}\n\nGenerated files regenerated with: ${regenerate.command}`,
      paths: [...input.conflict],
      patterns: regenerate.paths,
    });
    if (!proceed()) return { stopped: true };
    if (!committed.ok) return { ok: false, detail: `${committed.reason}: ${committed.paths.join(', ')}` };
    input.deps.timeline.append({
      projectKey: input.projectKey,
      taskKey: input.taskKey,
      actor: SYSTEM_ACTOR,
      type: 'task_note',
      data: { text: regeneratedNote(regenerate.command, input.conflict), mentions: [] },
    });
    return { ok: true, built: committed };
  } catch (err) {
    if (!proceed()) return { stopped: true };
    if (isEngineLinkLost(err)) throw err;
    return { ok: false, detail: messageOf(err) };
  } finally {
    await merger.releaseCheck(ref, { mergeId: regenId }).catch(() => {});
  }
}
