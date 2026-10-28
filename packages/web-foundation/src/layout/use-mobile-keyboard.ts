import { useEffect, useState } from 'react';

/** Collapse secondary chrome only while a text field has an occluding software keyboard. */
export function useMobileKeyboard(enabled: boolean): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    let baseline = window.innerHeight;
    let baselineWidth = window.innerWidth;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        const editing =
          active instanceof HTMLElement &&
          (active.isContentEditable ||
            active.matches('input:not([type=checkbox]):not([type=radio]), textarea'));
        // Rotation changes the layout width; its shorter height is not keyboard occlusion.
        if (!editing || window.innerWidth !== baselineWidth) {
          baseline = window.innerHeight;
          baselineWidth = window.innerWidth;
        }
        // Scale removes the height lost to pinch or focus zoom. Any remaining loss can be
        // the keyboard even while zoomed, so zoom must not force the navigation back on screen.
        const height = viewport ? viewport.height * viewport.scale : window.innerHeight;
        setVisible(editing && baseline - height > 120);
      });
    };
    document.addEventListener('focusin', measure);
    document.addEventListener('focusout', measure);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', measure);
      document.removeEventListener('focusout', measure);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [enabled]);
  return enabled && visible;
}

/**
 * The visible height above the software keyboard while `enabled`, else null.
 *
 * iOS Safari keeps `dvh` at the full window when the keyboard opens and scrolls the page instead,
 * which pushes a bottom composer out of sight; a column sized to this stays above the keyboard.
 */
export function useVisualViewportHeight(enabled: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const measure = (): void => {
      setHeight(viewport.height);
      window.scrollTo(0, 0);
    };
    measure();
    viewport.addEventListener('resize', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
    };
  }, [enabled]);
  // Masked here, not reset in the effect, so a stale height never outlives `enabled`.
  return enabled ? height : null;
}
