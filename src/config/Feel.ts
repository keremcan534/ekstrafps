import defaults from './feel.json';

/** Global feel multipliers & toggles (src/config/feel.json). */
export type FeelConfig = typeof defaults;
export const feel: FeelConfig = structuredClone(defaults);
export const feelDefaults: Readonly<FeelConfig> = structuredClone(defaults);
