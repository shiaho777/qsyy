// Minimal host stubs for the FluidBackground port.
export const ARRIVING_MARK = 'data-arriving';
export const useFirstFrameDrawn = () => () => {};
export const useLayerUnseen = () => false;
export const useBlendedColors = <T,>(colors: T, _blendMs?: number, _progress?: unknown): T => colors;
