// Ported from Folia (src/components/visualizer/fume/entry.tsx)
// AGPL-3.0. See ../../NOTICE.md and ../../LICENSE.
// The upstream defineVisualizer registration shell (settings panel, quick
// controls, background registry) is not needed in the standalone port:
// main.tsx lazily imports VisualizerFume directly. Only the mode's identity is
// kept here; the background config lives in ./backgroundConfig.
export const fumeEntry = {
    mode: 'fume',
    labelFallback: 'Fume',
    previewSeed: 'fume',
    previewStartOffset: 18.4,
    // 浮名：主歌词超出画面边界，背后叠着淡化的上下文
    keywords: ['fume', '浮名'],
} as const;

export default fumeEntry;