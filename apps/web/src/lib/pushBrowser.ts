/**
 * The browser's side of web push (PM-815): what this browser can do, its permission, and this device's
 * push subscription. Everything that touches `Notification`, `PushManager` or the service worker is here,
 * so the screens and their tests stay free of browser globals (tests replace this module).
 */

export type PushSupport = 'supported' | 'unsupported' | 'ios_install';
export type PushPermission = NotificationPermission | 'unsupported';

/** The part of a `PushSubscription` the server needs (`SubscribePushRequest`). */
export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface IosNavigator extends Navigator {
  standalone?: boolean;
}

/** The installed web app: started from the home screen / app launcher, not in a browser tab. */
export function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone =
    typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)');
  return (standalone && standalone.matches) || (navigator as IosNavigator).standalone === true;
}

function isIosBrowser(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** iPhone and iPad take push in the installed app only (iOS 16.4+), so a Safari tab is told to install first. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  if (isIosBrowser() && !isInstalledApp()) return 'ios_install';
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    ? 'supported'
    : 'unsupported';
}

export function readPermission(): PushPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Only ever called from a button press: the browser's permission prompt must follow a user gesture. */
export function requestPermission(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

/** The registration of the PM-814 service worker; registered here when this page has not done it yet (development). */
async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (!existing) await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

function fromSubscription(subscription: PushSubscription): BrowserSubscription {
  const json = subscription.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  if (!json.endpoint || !p256dh || !auth) throw new Error('incomplete push subscription');
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** This device's subscription, or null when there is none (or push is not available here). */
export async function currentSubscription(): Promise<BrowserSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  const existing = await navigator.serviceWorker.getRegistration('/');
  const subscription = existing ? await existing.pushManager.getSubscription() : null;
  return subscription ? fromSubscription(subscription) : null;
}

function keyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(publicKey.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** A fresh subscription with the server's public key; an older one made with another key is replaced. */
export async function subscribeBrowser(publicKey: string): Promise<BrowserSubscription> {
  const reg = await registration();
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe();
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
  return fromSubscription(subscription);
}

/** Drops this device's browser-side subscription; true when there was one. */
export async function unsubscribeBrowser(): Promise<boolean> {
  if (pushSupport() !== 'supported') return false;
  const existing = await navigator.serviceWorker.getRegistration('/');
  const subscription = existing ? await existing.pushManager.getSubscription() : null;
  return subscription ? subscription.unsubscribe() : false;
}

/** The endpoint's SHA-256 in hex: the server's `endpointHash`, how a device list finds "this device". */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
