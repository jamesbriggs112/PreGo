export type ProfileName = 'mobile' | 'tablet' | 'desktop' | 'kiosk-landscape' | 'kiosk-portrait';

export interface ViewportProfile {
  name: ProfileName;
  label: string;
  width: number;
  height: number;
  touch: boolean;
  /** Emulate a mobile device (meta viewport, mobile user agent behaviour). */
  mobile: boolean;
  deviceScaleFactor: number;
}

export const PROFILES: Record<ProfileName, ViewportProfile> = {
  mobile: { name: 'mobile', label: 'Mobile', width: 375, height: 812, touch: true, mobile: true, deviceScaleFactor: 2 },
  tablet: { name: 'tablet', label: 'Tablet', width: 768, height: 1024, touch: true, mobile: true, deviceScaleFactor: 2 },
  desktop: { name: 'desktop', label: 'Desktop', width: 1440, height: 900, touch: false, mobile: false, deviceScaleFactor: 1 },
  'kiosk-landscape': {
    name: 'kiosk-landscape', label: 'Kiosk landscape', width: 1920, height: 1080, touch: true, mobile: false, deviceScaleFactor: 1,
  },
  'kiosk-portrait': {
    name: 'kiosk-portrait', label: 'Kiosk portrait', width: 1080, height: 1920, touch: true, mobile: false, deviceScaleFactor: 1,
  },
};

export function isProfileName(name: string): name is ProfileName {
  return Object.hasOwn(PROFILES, name);
}

export interface Emulation {
  reducedMotion?: boolean;
  /** Windows high contrast mode. */
  forcedColors?: boolean;
  darkMode?: boolean;
  /** 200% browser zoom: half the CSS viewport at double the pixel density. */
  zoom200?: boolean;
}

/** Name used for a profile + emulation combination in findings and file names, e.g. `mobile+dark`. */
export function viewportName(profile: ProfileName, emulation: Emulation = {}): string {
  const flags = [
    emulation.reducedMotion && 'reduced-motion',
    emulation.forcedColors && 'forced-colors',
    emulation.darkMode && 'dark',
    emulation.zoom200 && 'zoom200',
  ].filter(Boolean);
  return [profile, ...flags].join('+');
}
