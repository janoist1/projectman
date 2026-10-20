import { api } from '../api/endpoints';
import { currentSubscription, unsubscribeBrowser } from './pushBrowser';

/** How long a logout waits for the device to be taken off the server's list before it goes on without. */
const UNSUBSCRIBE_WAIT_MS = 3000;

/**
 * Logging out must stop this browser's notifications: the next person to sign in here would otherwise get the
 * last one's items (PM-815). The server's row goes first, while the session still allows it, then the browser's
 * own subscription. Nothing here may keep the person from logging out, so a failure or a slow server is ignored.
 */
export async function unsubscribeThisDevice(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    const subscription = await currentSubscription();
    if (!subscription) return;
    await api.unsubscribePush(subscription.endpoint);
    await unsubscribeBrowser();
  })().catch(() => undefined);
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, UNSUBSCRIBE_WAIT_MS);
  });
  await Promise.race([work, wait]);
  clearTimeout(timer);
}
