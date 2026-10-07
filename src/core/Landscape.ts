/**
 * Phones play SITE-9 sideways. On a tap (a user gesture: both calls need one) the page goes
 * fullscreen without the navigation bar, then locks to landscape. Android Chrome honours
 * both; iOS has neither on iPhone and older WebKit returns no promise, so everything is
 * optional and the portrait cover (.rotate-hint) asks the player to turn the phone instead.
 */
export function enterLandscape(): void {
  const lock = () => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> } | undefined)?.lock?.('landscape')?.catch(() => {});
  try {
    if (document.fullscreenElement) {
      void lock();
      return;
    }
    document.documentElement
      .requestFullscreen?.({ navigationUI: 'hide' })
      .then(lock)
      .catch(() => {});
  } catch {
    /* no fullscreen here */
  }
}

/** The screen is taller than wide (the portrait cover is up). */
export const portraitQuery = (): MediaQueryList => window.matchMedia('(orientation: portrait)');
