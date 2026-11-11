import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { motionValue } from 'framer-motion';
import VisualizerTilt from './VisualizerTilt';
import FluidBackground from './FluidBackground';
import { DEFAULT_TILT_TUNING, type Line, type Theme } from './types';
import './obs.css';

const params = new URLSearchParams(location.search);
const transparent = params.get('bg') === 'transparent';
const showPill = params.get('pill') !== '0';

const tiltParam = params.get('tilt');
const tiltProbability = tiltParam === '1' ? 1 : (tiltParam == null ? 0.35 : Number(tiltParam));
const tiltTuning = {
  ...DEFAULT_TILT_TUNING,
  ...(Number.isFinite(tiltProbability) ? { tiltStyleProbability: Math.max(0, Math.min(1, tiltProbability as number)) } : {}),
};

const theme: Theme = {
  name: 'tilt',
  backgroundColor: '#050914',
  primaryColor: '#f8fafc',
  accentColor: params.get('accent') || '#7dd3fc',
  secondaryColor: 'rgba(226, 238, 255, .62)',
  fontStyle: 'sans',
  animationIntensity: 'normal',
};

const fmt = (ms: number) => {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

type Snapshot = {
  track: { id: string; title: string; artist: string; cover: string; duration: number };
  position: number;
  playing: boolean;
  updatedAt: number;
  spectrum: number[] | null;
  lyricsTrackId: string;
  lyrics: unknown;
};

const emptySnapshot: Snapshot = {
  track: { id: '', title: '', artist: '', cover: '', duration: 0 },
  position: 0,
  playing: false,
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
    return {
      startTime: start,
      endTime: Math.max(start + 0.2, end),
      fullText: String(row?.text || ''),
      translation: String(row?.cn || ''),
      words,
    };
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

// ---------------------------------------------------------------- player
const PlayerBar: React.FC<{ track: Snapshot['track']; position: number; playing: boolean }> = ({ track, position, playing }) => {
  if (!showPill || !track.title) return null;
  const duration = Number(track.duration) || 0;
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  return (
    <div className="folio-player">
      <span className={`folio-play${playing ? ' playing' : ''}`} />
      <span className="folio-cover">
        {track.cover ? <img src={track.cover} alt="" /> : <span>♪</span>}
      </span>
      <span className="folio-meta">
        <span className="folio-title">{track.title}</span>
        <span className="folio-artist">{track.artist}</span>
      </span>
      <span className="folio-progress"><i style={{ width: `${(progress * 100).toFixed(2)}%` }} /></span>
      <span className="folio-time">{fmt(position * 1000)} / {fmt(duration * 1000)}</span>
    </div>
  );
};

// ---------------------------------------------------------------- app
const App: React.FC = () => {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [lines, setLines] = useState<Line[]>([]);
  const [lineIndex, setLineIndex] = useState(-1);
  const currentTime = useMemo(() => motionValue(0), []);
  const audioPower = useMemo(() => motionValue(0), []);
  const audioBands = useMemo(() => ({
    bass: motionValue(0), lowMid: motionValue(0), mid: motionValue(0),
    vocal: motionValue(0), treble: motionValue(0),
  }), []);
  const lyricsTrackRef = useRef('');
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const response = await fetch('/api/now-playing?lyrics=0', { cache: 'no-store' });
        const next = await response.json();
        if (stopped) return;
        const lyricsId = String(next.lyricsTrackId || '');
        if (lyricsId && lyricsId !== lyricsTrackRef.current) {
          try {
            const lyricResponse = await fetch('/api/lyrics/current', { cache: 'no-store' });
            const lyricPayload = await lyricResponse.json();
            if (String(lyricPayload.track?.id || '') === String(next.track?.id || '')) {
              setLines(mapLines(lyricPayload.lyrics));
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
            cover: String(next.track?.cover || ''),
            duration: Number(next.track?.duration) || 0,
          },
          position: Number(next.position) || 0,
          playing: Boolean(next.playing),
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

  const activeLine = lineIndex >= 0 ? lines[lineIndex] : null;
  const nextLines = lineIndex >= 0 ? lines.slice(lineIndex + 1, lineIndex + 3) : lines.slice(0, 2);
  const seconds = currentTime.get();
  const duration = Number(snapshot.track.duration) || 0;
  const playing = snapshot.playing;

  return (
    <>
      {!transparent && <FluidBackground coverUrl={snapshot.track.cover} theme={theme} />}
      <div className="folio-vignette" />
      <VisualizerTilt
        currentTime={currentTime}
        currentLineIndex={lineIndex}
        lines={lines}
        theme={theme}
        subtitleTheme={theme}
        audioPower={audioPower}
        audioBands={audioBands}
        showText
        lyricsFontScale={1}
        subtitleFontScale={1}
        subtitleOverlayOpacity={0.75}
        subtitleOverlayBackground={false}
        subtitleUpcomingLyricsBlur
        isPlayerChromeHidden={false}
        hideTranslationSubtitle={false}
        tiltTuning={tiltTuning}
        songTitle={snapshot.track.title}
        songArtist={snapshot.track.artist}
        coverUrl={snapshot.track.cover}
        paused={!playing}
      />
      <PlayerBar track={snapshot.track} position={seconds} playing={playing} />
      <div className="folio-brand">qsyy · TILT · Folia port</div>
    </>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
