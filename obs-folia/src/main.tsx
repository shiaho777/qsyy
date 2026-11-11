import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { motionValue } from 'framer-motion';
import VisualizerTilt from './VisualizerTilt';
import { DEFAULT_TILT_TUNING, type Line, type Theme } from './types';
import { standingWave, waterline } from './waves';
import { buildThemeIconArt } from './themeIcons';
import { ICON_NAMES } from './icons';
import { createRng } from './rng';
import type { LineArtSpec } from './lineart';
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

// ---------------------------------------------------------------- backdrop
// Folia line-art background: standing waves + a waterline + Lucide icon
// polylines. The geometry (standingWave/waterline/themeIcons) is ported from
// Folia's lumiere lineart, not hand-drawn here.
const Backdrop: React.FC<{ accent: string; seed: string }> = ({ accent, seed }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const startedAt = useRef(performance.now());
  useEffect(() => { startedAt.current = performance.now(); }, [seed]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let iconArt: LineArtSpec | null = null;
    const rgb = (() => {
      const match = accent.match(/^#?([0-9a-f]{6})$/i);
      if (!match) return [125, 211, 252];
      return [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16));
    })();
    const rgba = alpha => `rgba(${rgb.join(',')}, ${alpha})`;

    const resize = () => {
      width = innerWidth; height = innerHeight;
      dpr = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const aspect = width / Math.max(1, height);
      iconArt = buildThemeIconArt({
        names: ICON_NAMES,
        aspect,
        avoid: { cx: aspect * .5, cy: .46, w: Math.min(.86, aspect * .8), h: .38 },
        random: createRng(seed || 'tilt'),
        offset: 0,
        delay: .18,
        alpha: .46,
      });
    };

    const drawSpec = (spec: LineArtSpec, progress: number, time: number, alphaScale = 1) => {
      if (!spec) return;
      const scale = height;
      for (const path of spec.paths) {
        const local = Math.max(0, Math.min(1, (progress - path.delay) / Math.max(0.001, path.span)));
        if (local <= 0) continue;
        const points = path.points;
        let total = 0;
        const lengths = [0];
        for (let i = 1; i < points.length; i += 1) {
          total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
          lengths.push(total);
        }
        if (total <= 0) continue;
        const target = total * local;
        ctx.beginPath();
        ctx.moveTo(points[0][0] * scale, points[0][1] * scale);
        let drawn = 0;
        for (let i = 1; i < points.length; i += 1) {
          const segment = lengths[i] - lengths[i - 1];
          if (drawn + segment > target) {
            const f = (target - drawn) / segment;
            ctx.lineTo(
              (points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f) * scale,
              (points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f) * scale,
            );
            break;
          }
          ctx.lineTo(points[i][0] * scale, points[i][1] * scale);
          drawn += segment;
        }
        ctx.strokeStyle = rgba(path.alpha * alphaScale);
        ctx.lineWidth = Math.max(0.6, path.width * scale);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
      for (const node of spec.nodes) {
        if (progress < node.delay) continue;
        const twinkle = 0.55 + 0.45 * Math.sin(time * 1.7 + node.twinklePhase);
        ctx.fillStyle = rgba((node.size * 18) * twinkle * alphaScale);
        ctx.beginPath();
        ctx.arc(node.at[0] * scale, node.at[1] * scale, Math.max(1, node.size * scale * .55), 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      const time = (now - startedAt.current) / 1000;
      const aspect = width / Math.max(1, height);
      const waveProgress = Math.min(1, time / 1.2);
      const iconProgress = Math.min(1, time / 2.2);

      ctx.clearRect(0, 0, width, height);
      const glow = ctx.createRadialGradient(width * .5, height * .28, 0, width * .5, height * .5, Math.max(width, height) * .72);
      glow.addColorStop(0, rgba(.11));
      glow.addColorStop(.55, rgba(.035));
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      const waves = standingWave(aspect * .08, aspect * .92, .37, .065, 6, time * .35);
      drawSpec(waves, waveProgress, time, 1);
      drawSpec(waterline(aspect, .76, .018, 7, time * .22), waveProgress, time, .9);
      if (iconArt) drawSpec(iconArt, iconProgress, time, 1.15);
    };

    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [accent, seed]);

  return <canvas ref={ref} className="folio-backdrop" />;
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

  const accent = theme.accentColor;
  const activeLine = lineIndex >= 0 ? lines[lineIndex] : null;
  const nextLines = lineIndex >= 0 ? lines.slice(lineIndex + 1, lineIndex + 3) : lines.slice(0, 2);
  const seconds = currentTime.get();
  const duration = Number(snapshot.track.duration) || 0;
  const playing = snapshot.playing;

  return (
    <>
      {!transparent && <Backdrop accent={accent} seed={snapshot.track.id} />}
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
