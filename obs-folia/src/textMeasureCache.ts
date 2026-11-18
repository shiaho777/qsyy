// Local stand-in for Folia's src/components/visualizer/textMeasureCache.ts.
// AGPL-3.0. See ../NOTICE.md and ../LICENSE.
// Bounded LRU-style map helpers plus prefix-width accumulation, matching the
// call sites in the ported cappella/fume measurement code.

/** Inserts (refreshing recency) and evicts the oldest entries beyond `limit`. */
export const rememberBounded = <K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) {
        const oldest = cache.keys().next().value as K | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return value;
};

/**
 * Cumulative prefix widths: offsets[0] = 0 and offsets[i] = width of the first
 * i graphemes joined together (measured as one string, so shaping is kept).
 */
export const measurePrefixOffsets = (
    graphemes: string[],
    measure: (prefix: string) => number,
): number[] => {
    const offsets = new Array<number>(graphemes.length + 1);
    offsets[0] = 0;
    let prefix = '';
    for (let index = 0; index < graphemes.length; index += 1) {
        prefix += graphemes[index];
        offsets[index + 1] = measure(prefix);
    }
    return offsets;
};