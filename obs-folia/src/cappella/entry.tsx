// Ported from Folia (src/components/visualizer/cappella/entry.tsx)
// AGPL-3.0. See ../../NOTICE.md and ../../LICENSE.
// The upstream defineVisualizer registration shell (settings panel, quick
// controls, asset store) is not needed in the standalone port: main.tsx lazily
// imports VisualizerCappella directly. Only the mode's identity is kept here.
export const cappellaEntry = {
    mode: 'cappella',
    labelFallback: 'Cappella',
    previewSeed: 'cappella',
    previewStartOffset: 0,
    // 群唱：左右交替的对话气泡
    keywords: ['cappella', '群唱'],
} as const;

export default cappellaEntry;