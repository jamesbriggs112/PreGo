import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PregoDb } from './db/database.js';
import type { ReportBranding } from './export/docx.js';
import type { ProfileName } from './browser/profiles.js';
import { checkDefinitions } from './checks/registry.js';

export interface PregoSettings {
  branding: {
    companyName: string;
    /** Hex colour without #, used for report headings and table headers. */
    accentColour: string;
  };
  /** Defaults for the New audit form. */
  defaults: {
    viewports: ProfileName[];
    perTemplate: number;
    concurrency: number;
    delayMs: number;
    respectRobots: boolean;
    csvPreset: string;
    /** Checks ticked on the New audit form and run by the CLI. */
    checks: string[];
  };
  /** Optional AI review through Ollama on this computer. Off by default. */
  ai: { enabled: boolean; url: string; model: string };
}

export const DEFAULT_SETTINGS: PregoSettings = {
  branding: { companyName: 'Four', accentColour: '1F3A5F' },
  defaults: {
    viewports: ['desktop'],
    perTemplate: 3,
    concurrency: 2,
    delayMs: 500,
    respectRobots: true,
    csvPreset: 'prego',
    checks: checkDefinitions().filter((d) => d.defaultOn).map((d) => d.id),
  },
  ai: { enabled: false, url: 'http://127.0.0.1:11434', model: 'qwen2.5vl:7b' },
};

/** Ollama settings for an audit, or undefined when AI review is off. */
export function aiSettings(settings: PregoSettings): { url: string; model: string } | undefined {
  return settings.ai.enabled ? { url: settings.ai.url, model: settings.ai.model } : undefined;
}

export function getSettings(db: PregoDb): PregoSettings {
  const saved = db.getSetting<Partial<PregoSettings>>('settings') ?? {};
  return {
    branding: { ...DEFAULT_SETTINGS.branding, ...saved.branding },
    defaults: { ...DEFAULT_SETTINGS.defaults, ...saved.defaults },
    ai: { ...DEFAULT_SETTINGS.ai, ...saved.ai },
  };
}

export function saveSettings(db: PregoDb, settings: PregoSettings) {
  db.setSetting('settings', settings);
}

/** The report logo lives in the data folder, never in git. */
export function logoPath(dataDir: string): string {
  return join(dataDir, 'branding', 'logo.png');
}

/** Branding for the Word report: saved settings plus the uploaded logo, if any. */
export function reportBranding(db: PregoDb, dataDir: string): ReportBranding {
  const { branding } = getSettings(db);
  const logo = logoPath(dataDir);
  return { ...branding, logoPath: existsSync(logo) ? logo : undefined };
}
