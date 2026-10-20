import type { BranchMerger, FullTestSpec, MergeRepoRef } from '../../contracts';

/** All merge checks prepare missing dependencies under the executor's heavy-run lock. */
export async function prepareMergeCheck(
  merger: BranchMerger,
  ref: MergeRepoRef,
  input: Omit<Parameters<BranchMerger['checkoutForCheck']>[1], 'allowDependencyInstall'>,
) {
  const checkout = await merger.checkoutForCheck(ref, { ...input, allowDependencyInstall: true });
  const preparation: Pick<FullTestSpec, 'requireHeavyLock' | 'npmCi'> = {
    requireHeavyLock: true,
    ...(checkout.dependencyInstallRequired === true ? { npmCi: { ref, mergeId: input.mergeId } } : {}),
  };
  return { checkout, preparation };
}
