// Ported from Folia (src/components/visualizer/fume/tuning.ts)
// AGPL-3.0. See ../../NOTICE.md and ../../LICENSE.
// Simplified for the standalone port: the upstream defineVisualizerTuning
// registration shell (settings store fields, mod keys, storage merge) is
// dropped; the default tuning and the stored-value reader remain.
import { DEFAULT_FUME_TUNING, type FumeTuning } from '../types';
import { normalizeLyricRenderOverride } from '../lyricRenderQuality';

/** A finite number kept between `min` and `max`; anything else is the fallback. */
const inRange = (min: number, max: number) => (value: number, fallback: number) => (
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
);

const cameraSpeed = inRange(0.55, 1.85);
const glowIntensity = inRange(0, 1.8);
const backgroundObjectOpacity = inRange(0, 1);
const heroScale = inRange(0.82, 1.32);
const textHoldRatio = inRange(0, 1);

const cameraTrackingMode = (value: FumeTuning['cameraTrackingMode'] | undefined) => (
    value === 'stepped' || value === 'smooth'
        ? value
        : DEFAULT_FUME_TUNING.cameraTrackingMode
);

/** A stored tuning, or a part of one, as a whole valid tuning. */
export const resolveStoredFumeTuning = (
    stored: Partial<FumeTuning> & { textHoldStyle?: 'standard' | 'dimmed'; },
): FumeTuning => {
    // Before the hold was a ratio it was a style: "dimmed" is the half hold.
    const migratedTextHoldRatio = stored.textHoldStyle === 'dimmed'
        ? 0.5
        : DEFAULT_FUME_TUNING.textHoldRatio;
    return {
        hidePrintSymbols: stored.hidePrintSymbols ?? DEFAULT_FUME_TUNING.hidePrintSymbols,
        disableGeometricBackground: stored.disableGeometricBackground ?? DEFAULT_FUME_TUNING.disableGeometricBackground,
        backgroundObjectOpacity: backgroundObjectOpacity(
            stored.backgroundObjectOpacity ?? DEFAULT_FUME_TUNING.backgroundObjectOpacity,
            DEFAULT_FUME_TUNING.backgroundObjectOpacity,
        ),
        textHoldRatio: textHoldRatio(stored.textHoldRatio ?? migratedTextHoldRatio, DEFAULT_FUME_TUNING.textHoldRatio),
        cameraTrackingMode: cameraTrackingMode(stored.cameraTrackingMode),
        cameraSpeed: cameraSpeed(stored.cameraSpeed ?? DEFAULT_FUME_TUNING.cameraSpeed, DEFAULT_FUME_TUNING.cameraSpeed),
        glowIntensity: glowIntensity(stored.glowIntensity ?? DEFAULT_FUME_TUNING.glowIntensity, DEFAULT_FUME_TUNING.glowIntensity),
        heroScale: heroScale(stored.heroScale ?? DEFAULT_FUME_TUNING.heroScale, DEFAULT_FUME_TUNING.heroScale),
        render: normalizeLyricRenderOverride(stored.render),
    };
};

export default DEFAULT_FUME_TUNING;