// Ported from Folia (src/components/visualizer/cappella/tuning.ts)
// AGPL-3.0. See ../../NOTICE.md and ../../LICENSE.
// Simplified for the standalone port: the upstream defineVisualizerTuning
// registration shell (settings store fields, mod keys, storage actions) is
// dropped; only the default tuning and the stored-value resolver remain.
// Custom emoji/avatar packs are trimmed (see customPacks.ts), so a 'custom'
// source always falls back to the built-in one.
import { DEFAULT_CAPPELLA_TUNING, type CappellaAvatarSource, type CappellaTuning } from '../types';

const avatarSource = (source: CappellaAvatarSource | undefined): CappellaAvatarSource => (
    source === 'builtin' || source === 'color' || source === 'cover'
        ? source
        : DEFAULT_CAPPELLA_TUNING.avatarSource
);

/** A stored tuning, or a part of one, as a whole valid tuning. */
export const resolveStoredCappellaTuning = (parsed: Partial<CappellaTuning>): CappellaTuning => ({
    showEmoMessages: parsed.showEmoMessages ?? DEFAULT_CAPPELLA_TUNING.showEmoMessages,
    emojiPackSource: 'builtin',
    avatarSource: avatarSource(parsed.avatarSource),
});

export default DEFAULT_CAPPELLA_TUNING;