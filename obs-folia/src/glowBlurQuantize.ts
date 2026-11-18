// Local stand-in for Folia's src/utils/glowBlurQuantize.ts.
// AGPL-3.0. See ../NOTICE.md and ../LICENSE.
// The upstream file gates a Linux glyph-cache workaround behind a Lab switch;
// the standalone port always quantizes shadow blur to whole pixels (the
// switched-on branch) and never routes live text through the raster path.

export const isGlowBlurQuantized = () => false;

export const setCanvasTextGlow = (
    context: CanvasRenderingContext2D,
    shadowBlur: number,
    shadowColor: string,
) => {
    context.shadowBlur = Number.isFinite(shadowBlur) ? Math.max(0, Math.round(shadowBlur)) : 0;
    context.shadowColor = shadowColor;
};

export const clearCanvasTextGlow = (context: CanvasRenderingContext2D) => {
    context.shadowBlur = 0;
    context.shadowColor = 'transparent';
};

export const fillGlowText = (
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
) => {
    context.fillText(text, x, y);
};