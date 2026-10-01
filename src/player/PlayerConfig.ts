import defaults from '../config/player.json';

/**
 * All player movement & camera tuning lives in src/config/player.json.
 * The tuning panel edits this object live and can write it back to that file.
 */
export type PlayerConfig = typeof defaults;

export const playerConfig: PlayerConfig = structuredClone(defaults);
export const playerConfigDefaults: Readonly<PlayerConfig> = structuredClone(defaults);

// "Save to source" rewrites the JSON while the lab is running. Accept those
// updates without reloading the page: the live (already tuned) values stay
// in memory, and the next page load picks up the file.
if (import.meta.hot) import.meta.hot.accept('../config/player.json', () => {});
