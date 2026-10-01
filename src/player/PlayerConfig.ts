import defaults from '../config/player.json';

/**
 * All player movement & camera tuning lives in src/config/player.json.
 * The tuning panel edits this object live and can write it back to that file.
 */
export type PlayerConfig = typeof defaults;

export const playerConfig: PlayerConfig = structuredClone(defaults);
export const playerConfigDefaults: Readonly<PlayerConfig> = structuredClone(defaults);
