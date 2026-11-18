import React from 'react';
import type { Line, Theme } from './types';

interface Props {
  showText?: boolean;
  activeLine: Line | null;
  recentCompletedLine: Line | null;
  nextLines: Line[];
  theme: Theme;
  subtitleTheme?: Theme;
  translationFontSize: string;
  upcomingFontSize: string;
  subtitleOverlayOpacity?: number;
  hideTranslationSubtitle?: boolean;
  [key: string]: unknown;
}

// A compact version of Folia's shared bottom subtitle overlay: translation
// first, then the next line. It deliberately keeps the same content order.
const VisualizerSubtitleOverlay: React.FC<Props> = ({
  showText = true,
  activeLine,
  recentCompletedLine,
  nextLines,
  theme,
  subtitleTheme,
  translationFontSize,
  upcomingFontSize,
  subtitleOverlayOpacity = 0.72,
  hideTranslationSubtitle = false,
}) => {
  if (!showText || hideTranslationSubtitle) return null;
  const line = activeLine || recentCompletedLine;
  if (!line) return null;
  const next = nextLines.find(item => item.fullText?.trim());
  return (
    <div className="folio-subtitles" style={{ opacity: subtitleOverlayOpacity }}>
      {line.translation ? (
        <div className="folio-translation" style={{ color: (subtitleTheme || theme).secondaryColor, fontSize: translationFontSize }}>
          {line.translation}
        </div>
      ) : null}
      {next ? (
        <div className="folio-upcoming" style={{ fontSize: upcomingFontSize }}>
          {next.fullText}
        </div>
      ) : null}
    </div>
  );
};

export default VisualizerSubtitleOverlay;
