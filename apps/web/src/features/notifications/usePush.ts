import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { PushDeviceView, PushOverview, PushSettings } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import {
  currentSubscription,
  endpointHash,
  isInstalledApp,
  pushSupport,
  readPermission,
  requestPermission,
  subscribeBrowser,
  unsubscribeBrowser,
} from '../../lib/pushBrowser';
import type { PushPermission, PushSupport } from '../../lib/pushBrowser';

/** The person's push devices and settings (PM-815). */
export function usePushOverview(enabled = true) {
  return useQuery({ queryKey: queryKeys.push, queryFn: api.push, staleTime: 30_000, enabled });
}

function patchDevice(overview: PushOverview | undefined, device: PushDeviceView): PushOverview | undefined {
  return overview
    ? { ...overview, devices: overview.devices.map((row) => (row.id === device.id ? device : row)) }
    : overview;
}

/** Saves the settings at once: the screen shows the new value while the request runs, and jumps back on a failure. */
export function useSavePushSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: PushSettings) => api.savePushSettings(settings),
    onMutate: async (settings) => {
      await client.cancelQueries({ queryKey: queryKeys.push });
      const before = client.getQueryData<PushOverview>(queryKeys.push);
      client.setQueryData<PushOverview>(queryKeys.push, (overview) =>
        overview ? { ...overview, settings } : overview,
      );
      return { before };
    },
    onError: (_error, _settings, context) => {
      if (context?.before) client.setQueryData(queryKeys.push, context.before);
    },
  });
}

export function useSetPushDeviceEnabled() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setPushDeviceEnabled(id, enabled),
    onSuccess: (device) =>
      client.setQueryData<PushOverview>(queryKeys.push, (overview) => patchDevice(overview, device)),
  });
}

export function useRemovePushDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.removePushDevice(id),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.push }),
  });
}

/** The test notification: the device row carries the result (`lastResult`), also when it failed. */
export function useTestPushDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.testPushDevice(id),
    onSuccess: (device) =>
      client.setQueryData<PushOverview>(queryKeys.push, (overview) => patchDevice(overview, device)),
    onError: () => client.invalidateQueries({ queryKey: queryKeys.push }),
  });
}

export type ThisDeviceState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' }
  | { kind: 'ios_install' }
  | { kind: 'denied' }
  | { kind: 'asking' }
  | { kind: 'off'; failed: boolean }
  | { kind: 'expired'; device: PushDeviceView }
  | { kind: 'on'; device: PushDeviceView };

export interface ThisDevice {
  state: ThisDeviceState;
  /** The row of this browser in the server's list, whatever its state; null when the server does not know it. */
  device: PushDeviceView | null;
  support: PushSupport;
  /** Asks for the permission (only here, from a press), subscribes and saves the device. */
  enable: () => Promise<boolean>;
  /** Reads the permission again (after the person allowed it in the browser's settings); subscribes when it is granted. */
  recheck: () => Promise<boolean>;
  /** Unsubscribes this browser and removes its row. */
  disable: () => Promise<void>;
  /** The server forgot this browser (a deleted row): forget the browser's subscription too. */
  forget: () => Promise<void>;
}

/**
 * Where this browser stands: its support, permission and subscription, set against the server's device list.
 * The browser's subscription is told from the list by the endpoint's SHA-256 (`endpointHash`).
 */
export function useThisDevice(overview: PushOverview | undefined): ThisDevice {
  const client = useQueryClient();
  const support = pushSupport();
  const [permission, setPermission] = useState<PushPermission>(() => readPermission());
  const [hash, setHash] = useState<string | null | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void currentSubscription()
      .then((subscription) => (subscription ? endpointHash(subscription.endpoint) : null))
      .catch(() => null)
      .then((value) => {
        if (live) setHash(value);
      });
    return () => {
      live = false;
    };
  }, [overview]);

  const device = (hash && overview?.devices.find((row) => row.endpointHash === hash)) || null;

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!overview?.publicKey) return false;
    setAsking(true);
    setFailed(false);
    try {
      const replaced = device;
      const subscription = await subscribeBrowser(overview.publicKey);
      const saved = await api.subscribePush({ ...subscription, installed: isInstalledApp() });
      // The revoked subscription's row is replaced by the new one, not kept next to it.
      if (replaced?.state === 'expired' && replaced.id !== saved.id) {
        await api.removePushDevice(replaced.id).catch(() => undefined);
      }
      await client.invalidateQueries({ queryKey: queryKeys.push });
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setAsking(false);
    }
  }, [client, device, overview?.publicKey]);

  const enable = useCallback(async (): Promise<boolean> => {
    if (readPermission() === 'default') {
      let answer: NotificationPermission;
      setAsking(true);
      try {
        answer = await requestPermission();
      } catch {
        setAsking(false);
        setFailed(true);
        return false;
      }
      setAsking(false);
      setPermission(answer);
      if (answer !== 'granted') return false;
    }
    return subscribe();
  }, [subscribe]);

  const recheck = useCallback(async (): Promise<boolean> => {
    const now = readPermission();
    setPermission(now);
    return now === 'granted' ? subscribe() : false;
  }, [subscribe]);

  const disable = useCallback(async (): Promise<void> => {
    const subscription = await currentSubscription();
    if (subscription) await api.unsubscribePush(subscription.endpoint);
    await unsubscribeBrowser().catch(() => false);
    setHash(null);
    await client.invalidateQueries({ queryKey: queryKeys.push });
  }, [client]);

  const forget = useCallback(async (): Promise<void> => {
    await unsubscribeBrowser().catch(() => false);
    setHash(null);
  }, []);

  let state: ThisDeviceState;
  if (support !== 'supported') state = { kind: support };
  else if (!overview || hash === undefined) state = { kind: 'loading' };
  else if (!overview.available) state = { kind: 'unavailable' };
  else if (asking) state = { kind: 'asking' };
  else if (permission === 'denied') state = { kind: 'denied' };
  else if (device?.state === 'expired') state = { kind: 'expired', device };
  else if (device?.enabled) state = { kind: 'on', device };
  else state = { kind: 'off', failed };

  return { state, device, support, enable, recheck, disable, forget };
}
