/**
 * The host's provider keys (the NanoGPT key in the hub's store) belong to the chopper's host owner alone
 * (PM-1068): another person's project does not make them a manager of the host's key. An engine's own key
 * file is managed on that engine's machine, not here.
 */
export function canManageProviderKeys(viewer: { hostOwner: boolean }): boolean {
  return viewer.hostOwner;
}
