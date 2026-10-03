/**
 * Graphics settings (Settings → Graphics). A preset fills every field; touching
 * any field turns the preset into "custom". Stored with the other menu prefs.
 */
export type GraphicsPreset = 'performance' | 'balanced' | 'quality' | 'custom';
export type ShadowQuality = 'off' | 'low' | 'high';
export type ViewDistance = 'near' | 'medium' | 'far';

export interface GraphicsSettings {
  preset: GraphicsPreset;
  /** Render pixel ratio (device pixels per CSS pixel): the render resolution. */
  resolution: number;
  /** Trade resolution for frame rate when frames slip (down to 55 % of `resolution`). */
  dynamicResolution: boolean;
  /** Frame cap (fps); 0 = as fast as the display refreshes. */
  fpsCap: number;
  /** Real-time sun shadows: off, 1024 or 2048 shadow map. */
  shadows: ShadowQuality;
  /** full: image-based lighting with reflections · fast: a light probe (same fill, no reflections). */
  lighting: 'fast' | 'full';
  /** Fog distance, how far rooms and characters are drawn. */
  viewDistance: ViewDistance;
  /** Colour grade pass + film grain / vignette overlay. */
  postFx: boolean;
  /** MSAA on the main framebuffer (takes effect after a restart). */
  antialias: boolean;
  /** Small fps / frame time / resolution readout. */
  showFps: boolean;
  /** Frosted-glass blur behind panels and buttons (phones: off, it costs a blur pass per element every frame). */
  uiBlur: boolean;
}

export const VIEW_DISTANCE: Record<ViewDistance, { fogNear: number; fogFar: number; rooms: number; roomFar: number; characters: number }> = {
  near: { fogNear: 32, fogFar: 80, rooms: 2, roomFar: 45, characters: 55 },
  medium: { fogNear: 55, fogFar: 130, rooms: 3, roomFar: 80, characters: 90 },
  far: { fogNear: 90, fogFar: 200, rooms: 3, roomFar: Infinity, characters: Infinity },
};

export const FPS_CAPS = [30, 60, 90, 120, 0];

/** Phones: texture anisotropy cap (Game passes it to setTextureAnisotropy before the map builds). */
export const MOBILE_ANISOTROPY = 2;

/** Body class `no-glass` (blur off): phones and blur turned off, unless ?glass keeps it (bisecting). */
export const noGlass = (mobile: boolean, g: GraphicsSettings): boolean => !new URLSearchParams(location.search).has('glass') && (mobile || !g.uiBlur);

/** Highest render resolution offered (phones: 2x is already far past what they can fill). */
export const maxResolution = (mobile: boolean): number => (mobile ? Math.min(2, Math.max(1, devicePixelRatio)) : Math.max(2, devicePixelRatio));

export function presetSettings(preset: Exclude<GraphicsPreset, 'custom'>, mobile: boolean): GraphicsSettings {
  const dpr = window.devicePixelRatio || 1;
  const base = { preset, fpsCap: mobile ? 60 : 0, showFps: false, antialias: !mobile, uiBlur: !mobile };
  switch (preset) {
    case 'performance':
      return { ...base, resolution: mobile ? 0.9 : 0.75, dynamicResolution: true, shadows: 'off', lighting: 'fast', viewDistance: 'near', postFx: false, antialias: false };
    case 'balanced':
      return { ...base, resolution: Math.min(dpr, 1.25), dynamicResolution: mobile, shadows: mobile ? 'off' : 'high', lighting: mobile ? 'fast' : 'full', viewDistance: mobile ? 'near' : 'far', postFx: !mobile };
    case 'quality':
      // Phones: sharper and fuller lighting, but no shadow pass, colour grade or MSAA (each one alone can halve the frame rate).
      return { ...base, resolution: Math.min(dpr, mobile ? 1.5 : 2), dynamicResolution: mobile, shadows: mobile ? 'off' : 'high', lighting: 'full', viewDistance: mobile ? 'medium' : 'far', postFx: !mobile, antialias: !mobile };
  }
}

const PREFS_KEY = 'site9.prefs';
/** Which control scheme the graphics settings were last loaded for ('mobile' / 'desktop'). */
const SCHEME_KEY = 'site9.gfxScheme';

/** Saved graphics settings (or the defaults for this device). Old saves carry only a preset name. */
export function loadGraphics(mobile: boolean): GraphicsSettings {
  let saved: { gfx?: Partial<GraphicsSettings>; graphics?: string; shadows?: boolean } = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    /* storage blocked */
  }
  const old = saved.graphics === 'performance' || saved.graphics === 'quality' ? saved.graphics : 'balanced';
  const d = presetSettings(old, mobile);
  if (saved.shadows === false) d.shadows = 'off';
  const g = saved.gfx;
  // A named preset always comes from its current definition (fixes travel to old saves);
  // only CUSTOM keeps the stored fields. Fps cap and the readout are kept either way.
  const out = g?.preset && g.preset !== 'custom' ? { ...presetSettings(g.preset, mobile), fpsCap: g.fpsCap ?? d.fpsCap, showFps: g.showFps ?? false } : { ...d, ...(g ?? {}) };
  // Switched to phone controls (or a save from before this was tracked): an uncapped or
  // above-60 cap was picked for a desktop monitor. A phone at 90/120 Hz would run the
  // whole game up to twice per 60 Hz frame and throttle: back to the phone default.
  // Written back to the save, so the menu (which loads these again) sees the same cap.
  // Real phones only (touch-first screen, not ?touch): touch controls on a desktop or a
  // touchscreen laptop keep the desktop's cap, it's the same save.
  try {
    const phone = mobile && !new URLSearchParams(location.search).has('touch') && window.matchMedia('(pointer: coarse)').matches;
    const scheme = localStorage.getItem(SCHEME_KEY);
    localStorage.setItem(SCHEME_KEY, phone ? 'mobile' : 'desktop');
    if (phone && scheme !== 'mobile' && g && (out.fpsCap === 0 || out.fpsCap > 60)) {
      out.fpsCap = g.fpsCap = 60;
      localStorage.setItem(PREFS_KEY, JSON.stringify(saved));
    }
  } catch {
    /* storage blocked */
  }
  return out;
}
