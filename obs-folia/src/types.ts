// Minimal type surface copied from Folia for the standalone Tilt port.
// The original Tilt component is kept close to its Folia form; only the
// host-specific types and stores are replaced by this local contract.

import type { MotionValue } from 'framer-motion';
import type { LineRenderHints } from './renderHints';

export interface LyricSyllable {
  text: string;
  startTime: number;
  endTime: number;
}

export interface Word {
  text: string;
  startTime: number; // seconds
  endTime: number;   // seconds
  syllables?: LyricSyllable[];
}

/** TTML x-bg block: same shape as a line, rendered smaller / weaker. */
export interface BackgroundVocal {
  words: Word[];
  startTime: number;
  endTime: number;
  fullText: string;
  translation?: string;
  romanization?: string;
}

export interface Line {
  words: Word[];
  startTime: number;
  endTime: number;
  fullText: string;
  translation?: string;
  id?: string;
  renderHints?: LineRenderHints;
  /** TTML agent id; cappella maps distinct agents to stable chat senders. */
  agentId?: string;
  /** Chorus marker; fume prefers short chorus lines as hero blocks. */
  isChorus?: boolean;
  /** TTML x-roman romanization line. */
  romanization?: string;
  /** TTML x-bg background vocals. */
  backgroundVocals?: BackgroundVocal[];
  [key: string]: unknown;
}

export interface Theme {
  name: string;
  backgroundColor: string;
  primaryColor: string;
  accentColor: string;
  secondaryColor: string;
  fontStyle: 'sans' | 'serif' | 'mono';
  fontFamily?: string;
  fontFamilyStack?: string[];
  fontWeight?: number;
  animationIntensity: 'calm' | 'normal' | 'chaotic';
  /** Optional semantic word colors; fume falls back to accentColor when absent. */
  wordColors?: ThemeWordColor[];
}

export type TiltColorScheme = 'default' | 'swap' | 'accentAll' | 'primaryAll';

export interface TiltTuning {
  splitProbability: number;
  tiltStyleProbability: number;
  colorScheme?: TiltColorScheme;
}

export const DEFAULT_TILT_TUNING: TiltTuning = {
  splitProbability: 0.75,
  tiltStyleProbability: 0.35,
  colorScheme: 'default',
};

export interface AudioBands {
  bass: MotionValue<number>;
  lowMid: MotionValue<number>;
  mid: MotionValue<number>;
  vocal: MotionValue<number>;
  treble: MotionValue<number>;
  spectrum?: MotionValue<Uint8Array<ArrayBuffer>>;
}

// ---------------------------------------------------------------------------
// Cappella / Fume port additions (upstream src/types.ts surface, trimmed to
// what the two ported renderers read).

export type CappellaAvatarSource = 'builtin' | 'color' | 'cover' | 'custom';

export interface CappellaEmojiImage {
  id: string;
  url: string;
  name: string;
}

/** Same shape as cappella/avatarImages.ts's CappellaAvatarImage, kept here for the shared props contract. */
export interface CappellaAvatarImage {
  id: string;
  name: string;
  url: string;
}

export interface CappellaTuning {
  showEmoMessages: boolean;
  emojiPackSource: 'builtin' | 'custom';
  avatarSource: CappellaAvatarSource;
}

// Field names and default values kept from upstream src/types.ts.
export const DEFAULT_CAPPELLA_TUNING: CappellaTuning = {
  showEmoMessages: true,
  emojiPackSource: 'builtin',
  avatarSource: 'cover',
};

/** Canvas lyric render resolution multiplier (upstream src/types.ts). */
export type LyricRenderScale = 0.5 | 0.75 | 1 | 1.5 | 2;

/** Per-mode render override; 'global' follows the global setting (1× in this port). */
export interface LyricRenderOverride {
  scale: 'global' | LyricRenderScale;
  antialias: 'global' | 'on' | 'off';
}

export interface FumeTuning {
  render: LyricRenderOverride;
  hidePrintSymbols: boolean;
  disableGeometricBackground: boolean;
  backgroundObjectOpacity: number;
  textHoldRatio: number;
  cameraTrackingMode: 'stepped' | 'smooth';
  cameraSpeed: number;
  glowIntensity: number;
  heroScale: number;
}

export const DEFAULT_FUME_TUNING: FumeTuning = {
  render: { scale: 'global', antialias: 'global' },
  hidePrintSymbols: false,
  disableGeometricBackground: true,
  backgroundObjectOpacity: 0.5,
  textHoldRatio: 1,
  cameraTrackingMode: 'smooth',
  cameraSpeed: 1,
  glowIntensity: 1,
  heroScale: 1,
};

export interface ThemeWordColor {
  word: string;
  color: string;
}
