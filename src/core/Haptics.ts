import { feel } from '../config/Feel';

/**
 * Tiny haptics wrapper. Android browsers support navigator.vibrate; iOS Safari
 * does not (the Capacitor build can swap this for @capacitor/haptics later).
 */
export const Haptics = {
  pulse(ms: number): void {
    if (!feel.haptics || typeof navigator.vibrate !== 'function') return;
    // Browsers refuse (and log errors) before the first user tap.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    try {
      navigator.vibrate(ms);
    } catch {
      /* ignore: some browsers throw without a user gesture */
    }
  },
};
