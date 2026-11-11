import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { motionValue } from 'framer-motion';
import VisualizerTilt from './VisualizerTilt';
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

// ---------------------------------------------------------------- backdrop
const Backdrop: React.FC<{ accent: string }> = ({ accent }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    const particles = Array.from({ length: 80 }, () => ({
      x: Math.random(), y: Math.random(),
      r: .7 + Math.random() * 2.2,
      vy: -.01 - Math.random() * .03,
      vx: -.01 + Math.random() * .02,
      phase: Math.random() * Math.PI * 2,
    }));
    const resize = () => {
      width = innerWidth; height = innerHeight;
      dpr = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const star = (x: number, y: number, r: number, rotation: number, alpha: number) => {
      ctx.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 ? r * .42 : r;
        const angle = rotation + (i / 10) * Math.PI * 2 - Math.PI / 2;
        if (i === 0) ctx.moveTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
        else ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
      }
      ctx.closePath();
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    };
    const cross = (x: number, y: number, size: number, rotation: number, alpha: number) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rotation);
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = Math.max(4, size * .18);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-size / 2, 0); ctx.lineTo(size / 2, 0);
      ctx.moveTo(0, -size / 2); ctx.lineTo(0, size / 2);
      ctx.stroke(); ctx.restore();
    };
    const circle = (x: number, y: number, r: number, alpha: number) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`; ctx.lineWidth = 1.1; ctx.stroke();
    };
    const squiggle = (x: number, y: number, w: number, amp: number, phase: number, alpha: number) => {
      ctx.beginPath();
      for (let i = 0; i <= 26; i += 1) {
        const px = x + (i / 26 - .5) * w;
        const py = y + Math.sin(i * .62 + phase) * amp;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`; ctx.lineWidth = 1.1; ctx.stroke();
    };
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      const t = now / 1000;
      ctx.clearRect(0, 0, width, height);
      // faint lyric-sized triangle, like the Tilt/Folia stage
      ctx.beginPath();
      ctx.moveTo(width * .5, height * .1);
      ctx.lineTo(width * .76, height * .92);
      ctx.lineTo(width * .24, height * .92);
      ctx.closePath();
      ctx.fillStyle = 'rgba(125, 211, 252, .025)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.055)';
      ctx.stroke();
      cross(width * .88, height * .14, 54, .18, .09);
      cross(width * .91, height * .36, 40, -.3, .065);
      cross(width * .08, height * .58, 36, -.2, .055);
      cross(width * .73, height * .78, 42, .4, .05);
      circle(width * .17, height * .9, 90, .07);
      circle(width * .80, height * .8, 120, .05);
      star(width * .14, height * .9, 38, t * .02, .06);
      star(width * .87, height * .26, 30, -t * .03, .055);
      squiggle(width * .5, height * .12, width * .18, 16, t * .2, .06);
      squiggle(width * .9, height * .55, width * .12, 12, -t * .2, .05);
      ctx.globalCompositeOperation = 'lighter';
      for (const p of particles) {
        p.x += p.vx / 60 * 6; p.y += p.vy / 60 * 6;
        if (p.y < -.05) p.y = 1.05;
        if (p.x < -.05) p.x = 1.05;
        if (p.x > 1.05) p.x = -.05;
        ctx.fillStyle = `rgba(190, 225, 255, ${.10 + .18 * (0.5 + 0.5 * Math.sin(t + p.phase))})`;
        ctx.beginPath(); ctx.arc(p.x * width, p.y * height, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [accent]);
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
      {!transparent && <Backdrop accent={accent} />}
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
