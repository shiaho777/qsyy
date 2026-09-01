'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { friendlyRestoreError, normalizeRestoreInput } = require('./restore-input');

const QUALITY_LABELS = {
  medium: '\u6807\u51c6\u97f3\u8d28',
  higher: '\u9ad8\u97f3\u8d28',
  highest: '\u6781\u9ad8\u97f3\u8d28',
  hi_res: 'Hi-Res\u97f3\u8d28',
  lossless: '\u65e0\u635f\u97f3\u8d28',
  spatial: '\u7a7a\u95f4\u97f3\u9891',
};

const FORMAT_SETTINGS = {
  source: { extension: '', codec: '' },
  m4a: { extension: 'm4a', codec: 'AAC', encoder: 'aac', bitrate: '256k' },
  mp3: { extension: 'mp3', codec: 'MP3', encoder: 'libmp3lame', bitrate: '320k' },
  flac: { extension: 'flac', codec: 'FLAC', encoder: 'flac' },
  wav: { extension: 'wav', codec: 'PCM', encoder: 'pcm_s16le' },
  ogg: { extension: 'ogg', codec: 'Vorbis', encoder: 'libvorbis', quality: '5' },
};

class RestoreService {
  constructor({ runtime, events, logger, filesystem = fs, pathModule = path, spawnProcess = spawn, spawnSyncProcess = spawnSync, processExecPath = process.execPath, timeoutMs = 180000 } = {}) {
    this.runtime = runtime;
    this.events = events;
    this.logger = logger || (() => {});
    this.filesystem = filesystem;
    this.path = pathModule;
    this.spawn = spawnProcess;
    this.spawnSync = spawnSyncProcess;
    this.processExecPath = processExecPath;
    this.timeoutMs = timeoutMs;
  }

  restore(input, jobId) {
    const normalized = normalizeRestoreInput(input);
    this.logger('restore-start', { jobId, ...normalized });
    this.events.publish('download-started', input, jobId, {
      status: 'downloading',
      progress: 0,
      phase: '\u51c6\u5907\u6062\u590d\u7f13\u5b58',
    });

    const runtime = this.runtime();
    if (!runtime.script || !runtime.lmdb || !runtime.device) {
      this.logger('restore-dependencies-missing', {
        jobId,
        script: Boolean(runtime.script),
        lmdb: Boolean(runtime.lmdb),
        device: Boolean(runtime.device),
      });
      throw new Error('local restore dependencies are missing');
    }

    this.filesystem.mkdirSync(normalized.outputDir, { recursive: true });
    this.events.publish('download-progress', input, jobId, {
      status: 'downloading',
      progress: 12,
      phase: '\u7b49\u5f85\u7f13\u5b58\u6587\u4ef6',
    });
    const args = [
      runtime.script,
      '--cache-dir', runtime.cacheDir,
      '--output-dir', normalized.outputDir,
      '--lmdb-module', runtime.lmdb,
      '--device-node', runtime.device,
      '--quality', normalized.quality,
      '--fuzzy',
      '--wait-ms', '120000',
      '--ffmpeg', runtime.ffmpeg,
    ];
    if (normalized.trackId) args.push('--track-id', normalized.trackId);
    for (const url of normalized.audioUrls) args.push('--audio-url', url);
    for (const [name, value] of [['title', normalized.title], ['artist', normalized.artist], ['album', normalized.album]]) {
      if (value) args.push(`--${name}`, value);
    }

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const startedAt = Date.now();
      const child = this.spawn(this.processExecPath, args, {
        cwd: this.path.dirname(runtime.script),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // inside the Electron desktop shell processExecPath is the Electron
        // binary; without this it swallows the script (exit 0, no output)
        env: { ...process.env, ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE },
      });
      const progressTimer = setInterval(() => {
        if (settled) return;
        const elapsed = Date.now() - startedAt;
        const progress = Math.min(55, 18 + Math.floor(Math.min(1, elapsed / 120000) * 37));
        this.events.publish('download-progress', input, jobId, {
          status: 'downloading',
          progress,
          phase: '\u7b49\u5f85\u6c7d\u6c34\u751f\u6210\u7f13\u5b58\u5e76\u6062\u590d\u97f3\u9891',
        });
      }, 500);
      const stopProgress = () => clearInterval(progressTimer);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stopProgress();
        child.kill();
        this.events.publish('download-failed', input, jobId, {
          status: 'failed',
          progress: 100,
          phase: '\u6062\u590d\u8d85\u65f6',
          error: '\u672c\u5730\u6062\u590d\u8d85\u65f6',
        });
        this.logger('restore-timeout', { jobId, outputDir: normalized.outputDir });
        reject(new Error('local restore timed out'));
      }, this.timeoutMs);
      child.stdout.on('data', data => { stdout += data.toString(); });
      child.stderr.on('data', data => { stderr += data.toString(); });
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopProgress();
        this.events.publish('download-failed', input, jobId, {
          status: 'failed',
          progress: 100,
          phase: '\u542f\u52a8\u6062\u590d\u8fdb\u7a0b\u5931\u8d25',
          error: error?.message || String(error),
        });
        this.logger('restore-process-error', { jobId, message: error?.message || String(error) });
        reject(error);
      });
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopProgress();
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let result;
        try { result = lines.length ? JSON.parse(lines[lines.length - 1]) : undefined; } catch (_) {}
        if (code === 0 && result?.ok !== false) {
          const output = this.finalizeOutput(result?.output || '', normalized, result || {});
          this.events.publish('download-progress', input, jobId, {
            status: 'downloading',
            progress: 92,
            phase: '\u5199\u5165\u97f3\u9891\u6807\u7b7e',
            chunkId: result?.chunkId || '',
          });
          this.events.publish('download-completed', input, jobId, {
            status: 'completed',
            progress: 100,
            phase: '\u4e0b\u8f7d\u5b8c\u6210',
            chunkId: result?.chunkId || '',
            output,
            validated: result?.validated === true,
            size: result?.size || 0,
          });
          this.logger('restore-finished', {
            jobId,
            chunkId: result?.chunkId || '',
            output,
            validated: result?.validated === true,
            size: result?.size || 0,
          });
          const lyrics = normalized.lyricsEnabled && normalized.lyricsText
            ? this.writeLyrics(normalized, output)
            : '';
          if (lyrics) this.logger('lyrics-written', { jobId, output: lyrics });
          resolve({ ...(result || { ok: true }), output, lyrics });
          return;
        }
        const error = result?.error || stderr.trim() || `restore exited with code ${code}`;
        const friendlyError = friendlyRestoreError(error, normalized.quality);
        const waiting = /No matching resourceId or chunkId/i.test(error);
        if (waiting) {
          this.events.publish('download-waiting', input, jobId, {
            status: 'waiting',
            progress: 0,
            phase: '\u7b49\u5f85\u6c7d\u6c34\u751f\u6210\u7f13\u5b58',
            error: friendlyError,
          });
          this.logger('restore-waiting-cache', { jobId, quality: normalized.quality });
          const waitingError = new Error(friendlyError);
          waitingError.waiting = true;
          reject(waitingError);
          return;
        }
        this.events.publish('download-failed', input, jobId, {
          status: 'failed',
          progress: 100,
          phase: '\u6062\u590d\u5931\u8d25',
          error: friendlyError,
        });
        this.logger('restore-failed', { jobId, error, friendlyError, outputDir: normalized.outputDir });
        reject(new Error(friendlyError));
      });
    });
  }

  finalizeOutput(output, normalized, result = {}) {
    if (!output || typeof this.filesystem.existsSync !== 'function' || !this.filesystem.existsSync(output)) return output;
    const sourceExtension = (this.path.extname(output).toLowerCase() || '.m4a').slice(1);
    const format = FORMAT_SETTINGS[normalized.outputFormat] || FORMAT_SETTINGS.source;
    const extension = format.extension || sourceExtension;
    const quality = QUALITY_LABELS[normalized.quality] || normalized.quality || '\u672a\u77e5\u97f3\u8d28';
    const codec = format.codec || cleanCodec(result.codec, sourceExtension);
    const base = cleanFilePart(normalized.title || 'unknown');
    const targetBase = `${base}_${cleanFilePart(quality)}_${cleanFilePart(codec || 'Audio')}`;
    let target = this.path.join(normalized.outputDir, `${targetBase}.${extension}`);
    let suffix = 2;
    while (target !== output && this.filesystem.existsSync(target)) {
      target = this.path.join(normalized.outputDir, `${targetBase} (${suffix}).${extension}`);
      suffix += 1;
    }
    const needsFfmpeg = Boolean(normalized.coverData) || normalized.outputFormat !== 'source';
    if (needsFfmpeg) {
      const converted = this.runFfmpeg(output, target, normalized, result, format);
      if (converted) return target;
    }
    if (target !== output) this.filesystem.renameSync(output, target);
    return target;
  }

  runFfmpeg(input, target, normalized, result, format) {
    const runtime = this.runtime();
    const executable = runtime.ffmpeg || 'ffmpeg';
    const tempCover = this.writeCoverTemp(normalized);
    // keep the real extension: ffmpeg infers the muxer from the output name
    const dot = target.lastIndexOf('.');
    const temporary = `${target.slice(0, dot)}.qishui-tmp${target.slice(dot)}`;
    const args = ['-y', '-i', input];
    if (tempCover) args.push('-i', tempCover);
    args.push('-map', '0:a:0');
    if (tempCover) args.push('-map', '1:v:0', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
    args.push('-c:a', format.encoder || 'copy');
    if (format.bitrate) args.push('-b:a', format.bitrate);
    if (format.quality) args.push('-q:a', format.quality);
    for (const [key, value] of [['title', normalized.title], ['artist', normalized.artist], ['album', normalized.album]]) {
      if (value) args.push('-metadata', `${key}=${value}`);
    }
    args.push(temporary);
    try {
      const result = this.spawnSync(executable, args, { windowsHide: true, encoding: 'utf8' });
      if (result?.status !== 0 || !this.filesystem.existsSync(temporary)) {
        this.logger('ffmpeg-finalize-failed', { status: result?.status ?? -1, output: target, message: String(result?.stderr || '').slice(-500) });
        return false;
      }
      if (this.filesystem.existsSync(input)) this.filesystem.unlinkSync(input);
      this.filesystem.renameSync(temporary, target);
      return true;
    } catch (error) {
      this.logger('ffmpeg-finalize-error', { output: target, message: error?.message || String(error) });
      return false;
    } finally {
      if (tempCover && this.filesystem.existsSync(tempCover)) this.filesystem.unlinkSync(tempCover);
      if (this.filesystem.existsSync(temporary)) this.filesystem.unlinkSync(temporary);
    }
  }

  writeCoverTemp(normalized) {
    if (!normalized.coverData || typeof this.filesystem.writeFileSync !== 'function') return '';
    const match = normalized.coverData.match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i);
    if (!match) return '';
    const extension = match[1].toLowerCase() === 'png' ? 'png' : 'jpg';
    const target = this.path.join(normalized.outputDir, `.qishui-cover-${Date.now()}.${extension}`);
    this.filesystem.writeFileSync(target, Buffer.from(match[2], 'base64'));
    return target;
  }

  writeLyrics(normalized, output) {
    const root = this.path.join(normalized.outputDir, '\u6b4c\u8bcd');
    const sourceName = normalized.title || output.split(/[\\/]/).pop() || 'unknown';
    const name = sourceName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
    const target = this.path.join(root, `${name}.lrc`);
    this.filesystem.mkdirSync(root, { recursive: true });
    this.filesystem.writeFileSync(target, `${normalized.lyricsText}\n`, 'utf8');
    return target;
  }
}

function cleanFilePart(value) {
  return String(value || 'unknown').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
}

function cleanCodec(value, extension) {
  const codec = String(value || '').replace(/[^a-z0-9.+-]/gi, '').toUpperCase();
  if (codec) return codec;
  return extension === 'mp4' ? 'FLAC' : extension.toUpperCase();
}

module.exports = { RestoreService };
