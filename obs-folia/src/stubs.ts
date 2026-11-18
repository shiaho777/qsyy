// Minimal host stubs for the FluidBackground / Cappella / Fume ports.
import { useCallback } from 'react';

export const ARRIVING_MARK = 'data-arriving';
// Stable identity matters: VisualizerFume lists the returned callback in a
// layout effect's deps, so a fresh function per render would re-run the layout.
export const useFirstFrameDrawn = () => useCallback(() => {}, []);
export const useLayerUnseen = () => false;
export const useBlendedColors = <T,>(colors: T, _blendMs?: number, _progress?: unknown): T => colors;