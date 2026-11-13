import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

// A close port of Folia's floating player capsule: a 56px resting bar that
// grows into a card with a draggable progress row, transport, shuffle/repeat,
// volume and the queue. Folia drives it from its own store; here every action
// is posted to qsyy's /api/player/control and executed by the tab that owns
// the <audio> element.

export type RemoteCommand = (action: string, value?: unknown) => void;

type Track = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  cover: string;
  duration: number;
};

type Status = {
  playing: boolean;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  volume: number;
  queueIndex: number;
  queueLength: number;
};

type QueueItem = {
  id: string;
  title: string;
  artist: string;
  cover: string;
  duration: number;
};

type QueueState = { index: number; items: QueueItem[] };

interface Props {
  track: Track;
  position: number;
  status: Status;
  onCommand: RemoteCommand;
}

const fmt = (seconds: number) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

// ---------------------------------------------------------------- icons
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const PlayIcon = () => <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden><path d="M8 5.2v13.6L18.8 12z" fill="currentColor" /></svg>;
const PauseIcon = () => <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden><rect x="7" y="5.4" width="3.6" height="13.2" rx="1.2" fill="currentColor" /><rect x="13.4" y="5.4" width="3.6" height="13.2" rx="1.2" fill="currentColor" /></svg>;
const PrevIcon = () => <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden {...stroke}><path d="M18.5 6.2v11.6L9 12z" fill="currentColor" stroke="none" /><path d="M5.8 5.5v13" /></svg>;
const NextIcon = () => <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden {...stroke}><path d="M5.5 6.2v11.6L15 12z" fill="currentColor" stroke="none" /><path d="M18.2 5.5v13" /></svg>;
const ShuffleIcon = () => <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden {...stroke}><path d="M3 7h3.4c5.5 0 8.7 10 14.2 10H21M3 17h3.4c2.2 0 3.9-1.5 5.2-3.2M12.3 10.2C13.6 8.6 15.3 7 17.4 7H21M18.6 4.5 21 7l-2.4 2.5M18.6 14.5 21 17l-2.4 2.5" /></svg>;
const RepeatIcon = () => <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden {...stroke}><path d="M4 12V9a3 3 0 0 1 3-3h13m0 0-3-3m3 3-3 3M20 12v3a3 3 0 0 1-3 3H4m0 0 3 3m-3-3 3-3" /></svg>;
const RepeatOneIcon = () => <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden {...stroke}><path d="M4 12V9a3 3 0 0 1 3-3h13m0 0-3-3m3 3-3 3M20 12v3a3 3 0 0 1-3 3H4m0 0 3 3m-3-3 3-3" /><path d="m11.4 14.6 1.1-4.4M12.9 11.1l-1.6.5" /></svg>;
const VolumeIcon = ({ level }: { level: number }) => level === 0
  ? <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden {...stroke}><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5zM16 9.5l5 5M21 9.5l-5 5" /></svg>
  : <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden {...stroke}><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" /><path d={level < 0.5 ? 'M15.5 9a4.2 4.2 0 0 1 0 6' : 'M15.5 9a4.2 4.2 0 0 1 0 6M18.2 6.5a8 8 0 0 1 0 11'} /></svg>;
const QueueIcon = () => <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden {...stroke}><path d="M4 6.5h11M4 12h11M4 17.5h7" /><path d="M18.5 10.5v8.2" /><circle cx="16.6" cy="18.7" r="1.7" fill="currentColor" stroke="none" /></svg>;
const ChevronIcon = ({ up }: { up: boolean }) => <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden {...stroke} style={{ transform: up ? 'rotate(180deg)' : 'none', transition: 'transform .28s cubic-bezier(.32,.72,0,1)' }}><path d="m6 9 6 6 6-6" /></svg>;

// ---------------------------------------------------------------- seek / volume
const Range: React.FC<{
  className: string;
  value: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  ariaLabel: string;
}> = ({ className, value, max = 100, step = 0.1, onChange, onCommit, ariaLabel }) => (
  <input
    type="range"
    className={className}
    min={0}
    max={max}
    step={step}
    value={value}
    aria-label={ariaLabel}
    style={{ '--p': `${(clamp01(value / max) * 100).toFixed(3)}%` } as React.CSSProperties}
    onChange={event => onChange(Number(event.currentTarget.value))}
    onPointerUp={event => onCommit?.(Number(event.currentTarget.value))}
    onKeyUp={event => onCommit?.(Number(event.currentTarget.value))}
  />
);

// ---------------------------------------------------------------- queue
const QueueList: React.FC<{
  queue: QueueState;
  onJump: (index: number) => void;
}> = ({ queue, onJump }) => {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const current = listRef.current?.querySelector<HTMLElement>('[data-current="1"]');
    current?.scrollIntoView({ block: 'nearest' });
  }, [queue.index, queue.items.length]);

  return (
    <motion.div
      className="fp-queue"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ height: { type: 'spring', stiffness: 360, damping: 40 }, opacity: { duration: 0.16 } }}
    >
      <div className="fp-queue-head">
        <span>播放队列</span>
        <span>{queue.items.length ? `${queue.index + 1} / ${queue.items.length}` : '空'}</span>
      </div>
      <div className="fp-queue-list" ref={listRef}>
        {queue.items.length === 0 && <div className="fp-queue-empty">队列还是空的，先在主界面播放一首歌</div>}
        {queue.items.map((item, index) => (
          <button
            type="button"
            key={`${item.id}-${index}`}
            data-current={index === queue.index ? '1' : '0'}
            className={`fp-queue-row${index === queue.index ? ' current' : ''}`}
            onClick={() => onJump(index)}
            title={item.title}
          >
            <span className="fp-queue-index">
              {index === queue.index
                ? <span className="fp-queue-wave"><i /><i /><i /></span>
                : String(index + 1)}
            </span>
            <span className="fp-queue-cover">
              <span className="fp-queue-note">♪</span>
              {item.cover ? <img src={item.cover} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none'; }} /> : null}
            </span>
            <span className="fp-queue-meta">
              <span className="fp-queue-title">{item.title}</span>
              <span className="fp-queue-artist">{item.artist}</span>
            </span>
            <span className="fp-queue-time">{item.duration > 0 ? fmt(item.duration) : ''}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
};

// ---------------------------------------------------------------- player
const PlayerControls: React.FC<Props> = ({ track, position, status, onCommand }) => {
  // Folia's capsule rests at 56px and grows on hover; a click pins it open.
  const [pinned, setPinned] = useState(() => {
    const mode = new URLSearchParams(location.search).get('controls');
    return mode === 'open' || mode === '1';
  });
  const [hovered, setHovered] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queue, setQueue] = useState<QueueState>({ index: 0, items: [] });
  const [scrub, setScrub] = useState<number | null>(null);
  const [localPlaying, setLocalPlaying] = useState(status.playing);
  const [localVolume, setLocalVolume] = useState(status.volume);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const volumeTimer = useRef<number | null>(null);
  const seekTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const expanded = pinned || hovered;

  const duration = Number(track.duration) || 0;
  const shownPosition = scrub ?? position;
  const progress = duration > 0 ? clamp01(shownPosition / duration) : 0;

  useEffect(() => setLocalPlaying(status.playing), [status.playing]);
  useEffect(() => setLocalVolume(status.volume), [status.volume]);

  const send = useCallback((action: string, value?: unknown) => onCommand(action, value), [onCommand]);

  const togglePlay = () => {
    setLocalPlaying(value => !value);
    send('toggle');
  };
  const jump = (index: number) => {
    send('jump', index);
    setQueue(current => ({ ...current, index }));
  };

  // The queue lives in the page that owns playback; fetch it fresh when the
  // card opens, and slowly while it stays open (tracks may be added elsewhere).
  useEffect(() => {
    if (!expanded && !queueOpen) return;
    let stopped = false;
    let timer = 0;
    const load = async () => {
      try {
        const response = await fetch('/api/player/queue', { cache: 'no-store' });
        const data = await response.json();
        if (stopped || !data?.ok) return;
        setQueue({
          index: Number(data.index) || 0,
          items: Array.isArray(data.items) ? data.items : [],
        });
      } catch (_) {}
      if (!stopped) timer = window.setTimeout(load, 2500);
    };
    load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [expanded, queueOpen, track.id]);

  // A collapsed card never keeps a queue drawer open.
  useEffect(() => {
    if (!expanded) setQueueOpen(false);
  }, [expanded]);

  // Collapse when clicking elsewhere, like the floating capsule.
  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setPinned(false);
        setHovered(false);
        setQueueOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [expanded]);

  useEffect(() => () => {
    if (volumeTimer.current) window.clearTimeout(volumeTimer.current);
    if (seekTimer.current) window.clearTimeout(seekTimer.current);
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
  }, []);

  const enter = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    setHovered(true);
  };
  const leave = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setHovered(false), 240);
  };
  const togglePinned = () => {
    if (pinned || hovered) {
      // Hover expanded the card but it was never pinned: a click on the
      // cover/chevron means close, not "keep it open forever".
      setPinned(false);
      setHovered(false);
    } else {
      setPinned(true);
    }
  };

  const changeVolume = (value: number) => {
    const next = clamp01(value / 100);
    setLocalVolume(next);
    if (volumeTimer.current) window.clearTimeout(volumeTimer.current);
    volumeTimer.current = window.setTimeout(() => send('volume', next), 90);
  };

  const changeSeek = (value: number) => {
    const seconds = duration > 0 ? (clamp01(value / 100) * duration) : 0;
    setScrub(seconds);
    if (seekTimer.current) window.clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => { send('seek', seconds); setScrub(null); }, 140);
  };

  const commitSeek = (value: number) => {
    if (seekTimer.current) window.clearTimeout(seekTimer.current);
    const seconds = duration > 0 ? (clamp01(value / 100) * duration) : 0;
    send('seek', seconds);
    setScrub(null);
  };

  const cycleRepeat = () => {
    const next = status.repeat === 'off' ? 'all' : status.repeat === 'all' ? 'one' : 'off';
    send('repeat', next);
  };

  const queueLabel = queue.items.length
    ? `${queue.index + 1} / ${queue.items.length}`
    : (status.queueLength ? `${status.queueIndex + 1} / ${status.queueLength}` : '');

  return (
    <div className={`fp-root${expanded ? ' expanded' : ''}`} ref={rootRef} onMouseEnter={enter} onMouseLeave={leave}>
      <div className="fp-card">
        <div className="fp-top">
          <button
            type="button"
            className="fp-cover"
            onClick={togglePinned}
            aria-label={expanded ? '收起播放器' : '展开播放器'}
          >
            {track.cover ? <img src={track.cover} alt="" /> : <span className="fp-cover-note">♪</span>}
            <span className={`fp-cover-ring${localPlaying ? ' on' : ''}`} />
          </button>
          <button type="button" className="fp-meta" onClick={togglePinned}>
            <span className="fp-title-line">
              <span className="fp-title">{track.title || '未在播放'}</span>
              {track.artist && <span className="fp-artist">{track.artist}</span>}
            </span>
            <span className="fp-mini-track" aria-hidden>
              <span className="fp-mini-fill" style={{ width: `${(progress * 100).toFixed(2)}%` }} />
            </span>
          </button>
          <button type="button" className="fp-icon fp-step" onClick={() => send('prev')} title="上一首" aria-label="上一首"><PrevIcon /></button>
          <button
            type="button"
            className="fp-play"
            onClick={togglePlay}
            title={localPlaying ? '暂停' : '播放'}
            aria-label={localPlaying ? '暂停' : '播放'}
          >
            {localPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button type="button" className="fp-icon fp-step" onClick={() => send('next')} title="下一首" aria-label="下一首"><NextIcon /></button>
          <button
            type="button"
            className={`fp-icon fp-expand${expanded ? ' open' : ''}`}
            onClick={togglePinned}
            title={expanded ? '收起' : '展开控制'}
            aria-label={expanded ? '收起' : '展开控制'}
          >
            <ChevronIcon up={expanded} />
          </button>
        </div>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="body"
              className="fp-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{
                height: { type: 'spring', stiffness: 380, damping: 42 },
                opacity: { duration: 0.18, ease: [0.32, 0.72, 0, 1] },
              }}
            >
              <div className="fp-body-inner">
                <div className="fp-seek-row">
                  <span className="fp-time">{fmt(shownPosition)}</span>
                  <Range
                    className="fp-seek"
                    value={progress * 100}
                    onChange={changeSeek}
                    onCommit={commitSeek}
                    ariaLabel="播放进度"
                  />
                  <span className="fp-time fp-time-end">{duration > 0 ? fmt(duration) : '--:--'}</span>
                </div>

                <div className="fp-controls">
                  <button
                    type="button"
                    className={`fp-icon${status.shuffle ? ' active' : ''}`}
                    onClick={() => send('shuffle', !status.shuffle)}
                    title={status.shuffle ? '随机播放：开' : '随机播放：关'}
                    aria-label="随机播放"
                  >
                    <ShuffleIcon />
                  </button>
                  <button
                    type="button"
                    className={`fp-icon${status.repeat !== 'off' ? ' active' : ''}`}
                    onClick={cycleRepeat}
                    title={status.repeat === 'off' ? '循环：关' : status.repeat === 'all' ? '列表循环' : '单曲循环'}
                    aria-label="循环模式"
                  >
                    {status.repeat === 'one' ? <RepeatOneIcon /> : <RepeatIcon />}
                  </button>
                  <span className="fp-spacer" />
                  <div className="fp-volume">
                    <button
                      type="button"
                      className="fp-icon fp-volume-btn"
                      onClick={() => send('volume', localVolume > 0 ? 0 : 0.9)}
                      title="静音切换"
                      aria-label="静音切换"
                    >
                      <VolumeIcon level={localVolume} />
                    </button>
                    <Range
                      className="fp-vol"
                      value={localVolume * 100}
                      onChange={changeVolume}
                      ariaLabel="音量"
                    />
                  </div>
                  <button
                    type="button"
                    className={`fp-icon${queueOpen ? ' active' : ''}`}
                    onClick={() => setQueueOpen(value => !value)}
                    title="播放队列"
                    aria-label="播放队列"
                  >
                    <QueueIcon />
                  </button>
                </div>

                <div className="fp-foot">
                  <span className="fp-album">{track.album || 'qsyy'}</span>
                  <span className="fp-queue-count">{queueLabel}</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {expanded && queueOpen && (
            <QueueList
              key="queue"
              queue={queue}
              onJump={jump}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default PlayerControls;
