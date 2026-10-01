import defaults from './feel.json';

/** Global feel multipliers & toggles (src/config/feel.json). */
export type FeelConfig = typeof defaults;
export const feel: FeelConfig = structuredClone(defaults);
export const feelDefaults: Readonly<FeelConfig> = structuredClone(defaults);

// "Save to source" rewrites the JSON while the lab is running. Accept those
// updates without reloading the page: the live (already tuned) values stay
// in memory, and the next page load picks up the file.
if (import.meta.hot) import.meta.hot.accept('./feel.json', () => {});
