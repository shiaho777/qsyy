// Ported from Folia (src/components/visualizer/cappella/customPacks.ts)
// AGPL-3.0. See ../../NOTICE.md and ../../LICENSE.
// TRIMMED for the standalone port: the upstream actions persist user-uploaded
// emoji/avatar packs through host services (IndexedDB) and a zustand asset
// store. Neither exists here, so custom packs are cut and only the built-in
// assets (avatar/, emo/) are used. The action surface is kept as no-ops so the
// shape stays recognizable; nothing imports it in this port.
import type { CappellaTuning } from '../types';

type UploadResult = Promise<{ ok: boolean; error?: string; }>;

export interface CappellaPackActions {
    handleImportCustomCappellaEmojiPack: (files: File[]) => UploadResult;
    handleClearCustomCappellaEmojiPack: () => Promise<void>;
    handleImportCustomCappellaAvatar: (files: File[]) => UploadResult;
    handleClearCustomCappellaAvatar: () => Promise<void>;
}

const notSupported = async (): UploadResult => ({
    ok: false,
    error: '独立版不支持自定义表情包，仅内置资产可用。',
});

export const cappellaPackActions = (_held: {
    held: () => CappellaTuning;
    hold: (tuning: CappellaTuning) => void;
}): CappellaPackActions => ({
    handleImportCustomCappellaEmojiPack: notSupported,
    handleClearCustomCappellaEmojiPack: async () => {},
    handleImportCustomCappellaAvatar: notSupported,
    handleClearCustomCappellaAvatar: async () => {},
});