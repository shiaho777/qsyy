// Minimal type surface copied from Folia for the standalone Tilt port.
// The original Tilt component is kept close to its Folia form; only the
// host-specific types and stores are replaced by this local contract.

import type { MotionValue } from 'framer-motion';

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

export interface Line {
  words: Word[];
  startTime: number;
  endTime: number;
  fullText: string;
  translation?: string;
  id?: string;
  renderHints?: unknown;
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
