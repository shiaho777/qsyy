// Local stand-in for Folia's src/components/visualizer/wordColoring.ts.
// AGPL-3.0. See ../NOTICE.md and ../LICENSE.
// Semantic word colors are optional in this port (theme.wordColors is usually
// absent, so the accent color is used); matching follows upstream's
// bidirectional-contains mode for CJK and whole-word matching otherwise.

import type { ThemeWordColor } from './types';

const isCJK = (text: string) => /[一-鿿぀-ヿ가-힯]/.test(text);

export const resolveWordColor = (
    wordText: string,
    wordColors: ThemeWordColor[] | undefined,
    fallbackColor: string,
    options?: { cjkMatchMode?: 'bidirectional-contains' | 'exact' },
): string => {
    const cleanCurrent = wordText.trim();
    if (!cleanCurrent || !wordColors || wordColors.length === 0) {
        return fallbackColor;
    }

    const matched = wordColors.find(entry => {
        const target = entry.word?.trim();
        if (!target) return false;
        if (isCJK(cleanCurrent)) {
            return options?.cjkMatchMode === 'exact'
                ? target === cleanCurrent
                : target.includes(cleanCurrent) || cleanCurrent.includes(target);
        }
        const targetWords = target.split(/\s+/).map(value => value.toLowerCase().replace(/[^\w]/g, ''));
        const normalizedCurrent = cleanCurrent.toLowerCase().replace(/[^\w]/g, '');
        return targetWords.includes(normalizedCurrent);
    });

    return matched?.color ?? fallbackColor;
};