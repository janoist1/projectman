/** Types of `browser.mjs`, for the TypeScript tests. */
import type { Account, Instance } from './instance.mjs';

export const DEFAULT_WIDTHS: number[];
export const BROWSER_NAME: string;
export const INSTALL_HINT: string;
export const USAGE: string;

/** A wrong command line or a missing browser: the exit code is 2. */
export class UsageError extends Error {}

export function viewportFor(width: number): { width: number; height: number };
export function browsersPath(env?: Record<string, string | undefined>, home?: string): string;
export function browserStatus(
  env?: Record<string, string | undefined>,
  home?: string,
): { path: string; revision: string; version: string; installed: boolean };
export function outputDirectory(input: {
  out?: string;
  scenario: string;
  env?: Record<string, string | undefined>;
  tmp?: string;
}): string;
export function isAllowedUrl(url: string, fence: { webUrl: string | null; serverUrl: string }): boolean;

export interface ShotsOptions {
  scenario: string;
  out: string | undefined;
  widths: number[];
  fullPage: boolean;
  scale: number;
  timeoutSeconds: number;
  seed: 'demo' | 'none';
  keepData: boolean;
}
export function parseWidths(text: string): number[];
export function parseArgs(argv: string[]): ShotsOptions;
export function launchBrowser(env?: Record<string, string | undefined>): Promise<any>;

export interface ShootOptions {
  widths?: number[];
  fullPage?: boolean;
  highlight?: string;
  mask?: string[];
}
export interface ScenarioApi {
  instance: Instance;
  open(input?: { as?: Account; path?: string; width?: number }): Promise<any>;
  shoot(page: any, name: string, options?: ShootOptions): Promise<string[]>;
  snapshot(page: any): Promise<string>;
  step<T>(title: string, fn: () => Promise<T>): Promise<T>;
  log(text: unknown): void;
}
export function createScenarioApi(input: {
  browser: any;
  instance: Pick<Instance, 'webUrl' | 'serverUrl' | 'owner' | 'storageState'>;
  out: string;
  widths?: number[];
  fullPage?: boolean;
  scale?: number;
  print?: (line: string) => void;
}): ScenarioApi;
