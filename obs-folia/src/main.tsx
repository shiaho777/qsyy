import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { motionValue } from 'framer-motion';
import VisualizerTilt from './VisualizerTilt';
import FluidBackground from './FluidBackground';
import PlayerControls from './PlayerControls';
import {
  DEFAULT_CAPPELLA_TUNING,
  DEFAULT_FUME_TUNING,
  DEFAULT_TILT_TUNING,
  type Line,
  type Theme,
} from './types';
import type { VisualizerSharedProps } from './definition';
import './obs.css';

// Code-split the two ported modes so the default Tilt page never downloads them.
const VisualizerCappella = lazy(() => import('./cappella/VisualizerCappella'));
const VisualizerFume = lazy(() => import('./fume/VisualizerFume'));

const params = new URLSearchParams(location.search);
const transparent = params.get('bg') === 'transparent';
const showControls = params.get('pill') !== '0' && params.get('controls') !== '0';

type Mode = 'tilt' | 'cappella' | 'fume';
const modeParam = params.get('mode');
const initialMode: Mode = modeParam === 'cappella' || modeParam === 'fume' ? modeParam : 'tilt';
// ?fumeBg=1 turns on fume's own geometric canvas background (upstream keeps it
// off by default); otherwise the shared FluidBackground stays the backdrop.
const fumeTuning = {
  ...DEFAULT_FUME_TUNING,
  disableGeometricBackground: params.get('fumeBg') !== '1',
};

const tiltParam = params.get('tilt');
const tiltProbability = tiltParam === '1' ? 1 : (tiltParam == null ? 0.35 : Number(tiltParam));
const tiltTuning = {
  ...DEFAULT_TILT_TUNING,
  ...(Number.isFinite(tiltProbability) ? { tiltStyleProbability: Math.max(0, Math.min(1, tiltProbability as number)) } : {}),
};

const buildTheme = (mode: Mode): Theme => ({
  name: mode,
  backgroundColor: '#050914',
  primaryColor: '#f8fafc',
  accentColor: params.get('accent') || '#7dd3fc',
  secondaryColor: 'rgba(226, 238, 255, .62)',
  fontStyle: 'sans',
  animationIntensity: 'normal',
});

type Snapshot = {
  track: { id: string; title: string; artist: string; album: string; cover: string; duration: number };
  position: number;
  playing: boolean;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  volume: number;
  queueIndex: number;
  queueLength: number;
  updatedAt: number;
  spectrum: number[] | null;
  lyricsTrackId: string;
  lyrics: unknown;
};

const emptySnapshot: Snapshot = {
  track: { id: '', title: '', artist: '', album: '', cover: '', duration: 0 },
  position: 0,
  playing: false,
  shuffle: false,
  repeat: 'off',
  volume: 0.9,
  queueIndex: 0,
  queueLength: 0,
  updatedAt: 0,
  spectrum: null,
  lyricsTrackId: '',
  lyrics: null,
};

const mapLines = (payload: any): Line[] => {
  const rows = Array.isArray(payload?.lines) ? payload.lines : [];
  return rows.map((row: any, index: number) => {
    const start = (Number(row?.ms) || 0) / 1000;
    let end = start + Math.max(0.3, (Number(row?.dur) || 0) / 1000);
    if (!(Number(row?.dur) > 0)) {
      const next = rows[index + 1];
      end = next ? (Number(next.ms) || 0) / 1000 : start + 4;
    }
    const words = (Array.isArray(row?.words) ? row.words : [])
      .map((word: any) => ({
        text: String(word?.w || ''),
        startTime: (Number(word?.t) || 0) / 1000,
        endTime: ((Number(word?.t) || 0) + (Number(word?.d) || 0)) / 1000,
      }))
      .filter((word: any) => word.text);
    const line: Line = {
      startTime: start,
      endTime: Math.max(start + 0.2, end),
      fullText: String(row?.text || ''),
      translation: String(row?.cn || ''),
      words,
    };
    // qsyy v2 extras: chorus marks, duet agents, TTML romanization / bg vocals.
    if (row?.chorus) line.isChorus = true;
    if (row?.agent) line.agentId = String(row.agent);
    if (row?.roman) line.romanization = String(row.roman);
    if (row?.bg?.text) {
      const bgStart = (Number(row.bg.ms) || 0) / 1000;
      const bgEnd = bgStart + Math.max(0.2, (Number(row.bg.dur) || 2000) / 1000);
      const bgWords = (Array.isArray(row.bg.words) ? row.bg.words : [])
        .map((word: any) => ({
          text: String(word?.w || ''),
          startTime: (Number(word?.t) || 0) / 1000,
          endTime: ((Number(word?.t) || 0) + (Number(word?.d) || 0)) / 1000,
        }))
        .filter((word: any) => word.text);
      line.backgroundVocals = [{
        startTime: bgStart,
        endTime: bgEnd,
        fullText: String(row.bg.text),
        translation: String(row.bg.cn || ''),
        words: bgWords,
        ...(row.bg.roman ? { romanization: String(row.bg.roman) } : {}),
      }];
    }
    return line;
  }).filter((line: Line) => line.fullText.trim());
};

const currentLineIndexAt = (lines: Line[], seconds: number) => {
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startTime <= seconds) index = i;
    else break;
  }
  return index;
};

// ---------------------------------------------------------------- app
const App: React.FC = () => {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [lines, setLines] = useState<Line[]>([]);
  const [lineIndex, setLineIndex] = useState(-1);
  const [mode, setMode] = useState<Mode>(initialMode);
  const theme = useMemo(() => buildTheme(mode), [mode]);
  const switchMode = useCallback((next: Mode) => {
    setMode(next);
    // Keep the URL shareable / OBS-source-stable without a reload.
    const url = new URL(location.href);
    if (next === 'tilt') url.searchParams.delete('mode');
    else url.searchParams.set('mode', next);
    history.replaceState(null, '', url);
  }, []);
  const currentTime = useMemo(() => motionValue(0), []);
  const audioPower = useMemo(() => motionValue(0), []);
  const audioBands = useMemo(() => ({
    bass: motionValue(0), lowMid: motionValue(0), mid: motionValue(0),
    vocal: motionValue(0), treble: motionValue(0),
  }), []);
  const lyricsTrackRef = useRef('');
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const sendCommand = useCallback((action: string, value?: unknown) => {
    fetch('/api/player/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, value }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    // Conditional polling: the server dirty-gates these endpoints, so an
    // unchanged state answers 304 with no body — skip parsing entirely.
    let snapshotEtag = '';
    let lyricsEtag = '';
    const poll = async () => {
      try {
        const response = await fetch('/api/now-playing?lyrics=0', {
          cache: 'no-store',
          headers: snapshotEtag ? { 'if-none-match': snapshotEtag } : undefined,
        });
        if (response.status === 304) {
          if (!stopped) timer = window.setTimeout(poll, 320);
          return;
        }
        snapshotEtag = response.headers.get('etag') || '';
        const next = await response.json();
        if (stopped) return;
        const lyricsId = String(next.lyricsTrackId || '');
        if (lyricsId && lyricsId !== lyricsTrackRef.current) {
          try {
            const lyricResponse = await fetch('/api/lyrics/current', {
              cache: 'no-store',
              headers: lyricsEtag ? { 'if-none-match': lyricsEtag } : undefined,
            });
            if (lyricResponse.status !== 304) {
              lyricsEtag = lyricResponse.headers.get('etag') || '';
              const lyricPayload = await lyricResponse.json();
              if (String(lyricPayload.track?.id || '') === String(next.track?.id || '')) {
                setLines(mapLines(lyricPayload.lyrics));
                lyricsTrackRef.current = lyricsId;
              }
            } else {
              lyricsTrackRef.current = lyricsId;
            }
          } catch (_) {}
        } else if (!lyricsId && lyricsTrackRef.current) {
          lyricsTrackRef.current = '';
          setLines([]);
        }
        setSnapshot({
          track: {
            id: String(next.track?.id || ''),
            title: String(next.track?.title || ''),
            artist: String(next.track?.artist || ''),
            album: String(next.track?.album || ''),
            cover: String(next.track?.cover || ''),
            duration: Number(next.track?.duration) || 0,
          },
          position: Number(next.position) || 0,
          playing: Boolean(next.playing),
          shuffle: Boolean(next.shuffle),
          repeat: next.repeat === 'all' || next.repeat === 'one' ? next.repeat : 'off',
          volume: Number.isFinite(Number(next.volume)) ? Math.max(0, Math.min(1, Number(next.volume))) : 0.9,
          queueIndex: Math.max(0, Number(next.queueIndex) || 0),
          queueLength: Math.max(0, Number(next.queueLength) || 0),
          updatedAt: Number(next.updatedAt) || Date.now(),
          spectrum: Array.isArray(next.spectrum) ? next.spectrum : null,
          lyricsTrackId: lyricsId,
          lyrics: null,
        });
      } catch (_) {}
      timer = window.setTimeout(poll, 320);
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = snapshotRef.current;
      const drift = state.playing ? Math.max(0, (Date.now() - state.updatedAt) / 1000) : 0;
      const duration = Number(state.track.duration) || 0;
      const seconds = duration > 0 ? Math.min(duration, state.position + drift) : state.position + drift;
      currentTime.set(seconds);
      const nextIndex = currentLineIndexAt(lines, seconds);
      setLineIndex(prev => (prev === nextIndex ? prev : nextIndex));
      const average = state.spectrum?.length
        ? state.spectrum.reduce((sum, value) => sum + value, 0) / state.spectrum.length / 255
        : 0;
      audioPower.set(average);
      audioBands.bass.set(average);
      audioBands.lowMid.set(average);
      audioBands.mid.set(average);
      audioBands.vocal.set(average);
      audioBands.treble.set(average);
    }, 60);
    return () => clearInterval(timer);
  }, [lines, currentTime, audioPower, audioBands]);

  useEffect(() => {
    document.body.classList.toggle('transparent', transparent);
  }, []);

  const seconds = currentTime.get();
  const playing = snapshot.playing;

  const sharedProps: VisualizerSharedProps = {
    currentTime,
    currentLineIndex: lineIndex,
    lines,
    theme,
    subtitleTheme: theme,
    audioPower,
    audioBands,
    showText: true,
    lyricsFontScale: 1,
    subtitleFontScale: 1,
    subtitleOverlayOpacity: 0.75,
    subtitleOverlayBackground: false,
    subtitleUpcomingLyricsBlur: true,
    isPlayerChromeHidden: false,
    hideTranslationSubtitle: false,
    songTitle: snapshot.track.title,
    songArtist: snapshot.track.artist,
    songAlbum: snapshot.track.album,
    coverUrl: snapshot.track.cover,
    duration: snapshot.track.duration,
    paused: !playing,
    tiltTuning,
    cappellaTuning: DEFAULT_CAPPELLA_TUNING,
    fumeTuning,
  };

  return (
    <>
      {!transparent && <FluidBackground coverUrl={snapshot.track.cover} theme={theme} />}
      <div className="folio-vignette" />
      <Suspense fallback={null}>
        {mode === 'cappella' ? (
          <VisualizerCappella {...sharedProps} />
        ) : mode === 'fume' ? (
          <VisualizerFume {...sharedProps} />
        ) : (
          <VisualizerTilt {...sharedProps} />
        )}
      </Suspense>
      {showControls && (
        <PlayerControls
          track={snapshot.track}
          position={seconds}
          status={{
            playing,
            shuffle: snapshot.shuffle,
            repeat: snapshot.repeat,
            volume: snapshot.volume,
            queueIndex: snapshot.queueIndex,
            queueLength: snapshot.queueLength,
          }}
          onCommand={sendCommand}
          mode={mode}
          onModeChange={switchMode}
        />
      )}
      <div className="folio-brand">qsyy · {mode.toUpperCase()} · Folia port</div>
    </>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
