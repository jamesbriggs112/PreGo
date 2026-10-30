import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVALUATE_SHIM } from './shim.js';
import { PROFILES, viewportName, type Emulation, type ProfileName } from './profiles.js';

export interface BasicAuth {
  username: string;
  password: string;
}

export interface BrowserSessionOptions {
  headless?: boolean;
  /** Basic auth credentials. Only sent to `authOrigin`, never to third-party hosts. */
  basicAuth?: BasicAuth;
  /** Origin the basic auth credentials are scoped to, e.g. `https://staging.example.com`. */
  authOrigin?: string;
  /** Saved browser session (cookies, local storage) to load into every context, if the file exists. */
  storageStatePath?: string;
}

export interface OpenedPage {
  context: BrowserContext;
  page: Page;
  /** e.g. `desktop` or `mobile+dark`. */
  viewport: string;
  close(): Promise<void>;
}

/**
 * Launches Chromium once and hands out pages configured for a viewport profile and emulation settings.
 * Each page gets its own context so profiles don't leak into each other.
 */
export class BrowserSession {
  // A shared promise, so concurrent newPage() calls never launch a second browser.
  private browser: Promise<Browser> | undefined;

  constructor(private readonly options: BrowserSessionOptions = {}) {}

  async start(): Promise<this> {
    this.browser ??= chromium.launch({ headless: this.options.headless ?? true });
    await this.browser;
    return this;
  }

  async close() {
    const browser = this.browser;
    this.browser = undefined;
    await (await browser)?.close();
  }

  contextOptions(profileName: ProfileName, emulation: Emulation = {}): BrowserContextOptions {
    const profile = PROFILES[profileName];
    const zoom = emulation.zoom200 ? 2 : 1;
    const { basicAuth, authOrigin, storageStatePath } = this.options;
    return {
      viewport: { width: Math.round(profile.width / zoom), height: Math.round(profile.height / zoom) },
      deviceScaleFactor: profile.deviceScaleFactor * zoom,
      hasTouch: profile.touch,
      isMobile: profile.mobile,
      reducedMotion: emulation.reducedMotion ? 'reduce' : 'no-preference',
      forcedColors: emulation.forcedColors ? 'active' : 'none',
      colorScheme: emulation.darkMode ? 'dark' : 'light',
      httpCredentials: basicAuth ? { ...basicAuth, origin: authOrigin, send: 'unauthorized' } : undefined,
      storageState: storageStatePath && existsSync(storageStatePath) ? storageStatePath : undefined,
    };
  }

  async newPage(profileName: ProfileName, emulation: Emulation = {}): Promise<OpenedPage> {
    await this.start();
    const context = await (await this.browser!).newContext(this.contextOptions(profileName, emulation));
    await context.addInitScript(EVALUATE_SHIM);
    const page = await context.newPage();
    return { context, page, viewport: viewportName(profileName, emulation), close: () => context.close() };
  }

  /** Save cookies and local storage from a context (e.g. after logging in) for later audits. */
  static async saveSession(context: BrowserContext, path: string) {
    mkdirSync(dirname(path), { recursive: true });
    await context.storageState({ path });
  }
}

/** Where a project's saved browser session lives. Always inside the git-ignored data folder. */
export function sessionPath(dataDir: string, projectSlug: string): string {
  return join(dataDir, 'sessions', `${projectSlug}.json`);
}
