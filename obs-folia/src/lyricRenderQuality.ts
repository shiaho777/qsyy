// Local stand-in for Folia's src/utils/lyricRenderQuality.ts and
// src/components/visualizer/renderQuality/useLyricRenderQuality.ts.
// AGPL-3.0. See ../NOTICE.md and ../LICENSE.
// The host's global render-scale setting does not exist here, so 'global'
// resolves to 1×; a per-mode numeric override is honored and capped at 3× DPR.

import { useMemo } from 'react';
import type { LyricRenderOverride, LyricRenderScale } from './types';

const MAX_PIXEL_RATIO = 3;
const VALID_SCALES: LyricRenderScale[] = [0.5, 0.75, 1, 1.5, 2];

const resolveScale = (value: LyricRenderOverride['scale'] | undefined): LyricRenderScale => (
    VALID_SCALES.includes(value as LyricRenderScale) ? (value as LyricRenderScale) : 1
);

export const normalizeLyricRenderOverride = (value: unknown): LyricRenderOverride => {
    const source = (value ?? {}) as Partial<LyricRenderOverride>;
    return {
        scale: source.scale === 'global' || VALID_SCALES.includes(source.scale as LyricRenderScale)
            ? (source.scale as LyricRenderOverride['scale'])
            : 'global',
        antialias: source.antialias === 'on' || source.antialias === 'off' ? source.antialias : 'global',
    };
};

export const resolveLyricPixelRatio = (devicePixelRatio: number, renderScale: LyricRenderScale = 1) => {
    const base = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
    return Math.min(base * renderScale, MAX_PIXEL_RATIO);
};

export const useLyricRenderQuality = (override?: LyricRenderOverride) => useMemo(() => ({
    scale: resolveScale(override?.scale),
    antialias: override?.antialias ?? 'global',
}), [override?.scale, override?.antialias]);