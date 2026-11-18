// Local stand-in for Folia's src/components/visualizer/colorMix.ts.
// AGPL-3.0. See ../NOTICE.md and ../LICENSE.
// Parses the color forms the standalone themes use (hex / rgb(a)) and mixes
// them in sRGB; unknown forms fall back to the first color unchanged.

interface RGBA {
    r: number;
    g: number;
    b: number;
    a: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const parseColor = (color: string): RGBA | null => {
    const text = color.trim();

    const hexMatch = /^#([0-9a-f]{3,8})$/i.exec(text);
    if (hexMatch) {
        const hex = hexMatch[1];
        if (hex.length === 3 || hex.length === 4) {
            return {
                r: parseInt(hex[0] + hex[0], 16),
                g: parseInt(hex[1] + hex[1], 16),
                b: parseInt(hex[2] + hex[2], 16),
                a: hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1,
            };
        }
        if (hex.length === 6 || hex.length === 8) {
            return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16),
                a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
            };
        }
        return null;
    }

    const rgbMatch = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(text);
    if (rgbMatch) {
        const alphaText = rgbMatch[4];
        const alpha = alphaText === undefined
            ? 1
            : alphaText.endsWith('%')
                ? Number(alphaText.slice(0, -1)) / 100
                : Number(alphaText);
        return {
            r: Number(rgbMatch[1]),
            g: Number(rgbMatch[2]),
            b: Number(rgbMatch[3]),
            a: Number.isFinite(alpha) ? alpha : 1,
        };
    }

    return null;
};

const formatColor = ({ r, g, b, a }: RGBA): string => {
    const round = (value: number) => Math.round(Math.max(0, Math.min(255, value)));
    const alpha = clamp01(a);
    return alpha >= 1
        ? `rgb(${round(r)}, ${round(g)}, ${round(b)})`
        : `rgba(${round(r)}, ${round(g)}, ${round(b)}, ${Number(alpha.toFixed(4))})`;
};

/** Mixes `amount` of `to` into `from`; optional `alpha` overrides the result alpha. */
export const mixColors = (from: string, to: string, amount: number, alpha?: number): string => {
    const fromColor = parseColor(from);
    const toColor = parseColor(to);
    if (!fromColor) {
        return alpha === undefined ? from : colorWithAlpha(from, alpha);
    }
    if (!toColor) {
        return alpha === undefined ? from : formatColor({ ...fromColor, a: alpha });
    }

    const t = clamp01(amount);
    return formatColor({
        r: fromColor.r + (toColor.r - fromColor.r) * t,
        g: fromColor.g + (toColor.g - fromColor.g) * t,
        b: fromColor.b + (toColor.b - fromColor.b) * t,
        a: alpha === undefined ? fromColor.a + (toColor.a - fromColor.a) * t : alpha,
    });
};

/** The color with its alpha replaced; unparseable colors are returned unchanged. */
export const colorWithAlpha = (color: string, alpha: number): string => {
    const parsed = parseColor(color);
    if (!parsed) {
        return color;
    }
    return formatColor({ ...parsed, a: alpha });
};