// The subset of Folia's VisualizerSharedProps that Tilt reads. Keeping the
// original names makes the copied Tilt component compile with minimal edits.

import type { MotionValue } from 'framer-motion';
import type { AudioBands, CappellaAvatarImage, CappellaEmojiImage, CappellaTuning, FumeTuning, Line, Theme, TiltTuning } from './types';

export interface VisualizerSharedProps {
  currentTime: MotionValue<number>;
  duration?: number;
  currentLineIndex: number;
  lines: Line[];
  theme: Theme;
  subtitleTheme?: Theme;
  isDaylight?: boolean;
  audioPower: MotionValue<number>;
  audioBands: AudioBands;
  showText?: boolean;
  songTitle?: string | null;
  songArtist?: string | null;
  songAlbum?: string | null;
  coverUrl?: string | null;
  seed?: string | number;
  staticMode?: boolean;
  lyricsFontScale?: number;
  subtitleFontScale?: number;
  subtitleOverlayOpacity?: number;
  subtitleOverlayBackground?: boolean;
  subtitleUpcomingLyricsBlur?: boolean;
  isPlayerChromeHidden?: boolean;
  hideTranslationSubtitle?: boolean;
  subtitleOverlayLayout?: unknown;
  tiltTuning?: TiltTuning;
  paused?: boolean;
  isPreviewMode?: boolean;
  cappellaTuning?: CappellaTuning;
  cappellaCustomEmojiImages?: CappellaEmojiImage[];
  cappellaCustomAvatarImages?: CappellaAvatarImage[];
  fumeTuning?: FumeTuning;
  background?: unknown;
  [key: string]: unknown;
}
