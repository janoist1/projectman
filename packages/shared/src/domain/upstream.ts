/** The projectman repository on GitHub: the issues go there, and so do the release assets (`engine-app publish`). */
export const PROJECTMAN_REPOSITORY = 'janoist1/projectman';

/** Where every release of projectman and its assets live; a release URL of the upstream starts with it. */
export const PROJECTMAN_RELEASES_URL = `https://github.com/${PROJECTMAN_REPOSITORY}/releases/`;

/** The motor app's disk image: the fixed asset name of the latest release. */
export function motorAppDownloadUrl(): string {
  return `${PROJECTMAN_RELEASES_URL}latest/download/projectman-motor.dmg`;
}

/** The deployment guide: how a machine is set up when there is no download. */
export function deployDocsUrl(): string {
  return `https://github.com/${PROJECTMAN_REPOSITORY}/blob/main/docs/DEPLOY.md`;
}
