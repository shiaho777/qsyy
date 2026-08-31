'use strict';

function requiredText(value, name, maxLength = 32768) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function normalizeCacheQuality(value) {
  const key = String(value || '').trim().toLowerCase();
  return ({ standard: 'medium', 'hi-res': 'hi_res', hires: 'hi_res', flac: 'lossless' })[key] || key;
}

function normalizeOutputFormat(value) {
  const key = String(value || '').trim().toLowerCase();
  return ['source', 'm4a', 'mp3', 'flac', 'wav', 'ogg'].includes(key) ? key : 'source';
}

function normalizeMetadataText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:SVIP|VIP)$/i, '')
    .trim();
}

function normalizeCacheArtist(value) {
  const normalized = normalizeMetadataText(value);
  const primary = normalized.split(/\s*[,\uFF0C\u3001|&]\s*/).filter(Boolean)[0];
  return primary || normalized;
}

function normalizeRestoreInput(input) {
  const requestedQuality = requiredText(input.quality, 'quality', 64);
  const quality = normalizeCacheQuality(requestedQuality);
  const outputDir = requiredText(input.outputDir, 'outputDir');
  const trackId = typeof input.trackId === 'string' ? input.trackId.trim() : '';
  const requestedTitle = typeof input.title === 'string' ? input.title.trim() : '';
  const requestedArtist = typeof input.artist === 'string' ? input.artist.trim() : '';
  const requestedAlbum = typeof input.album === 'string' ? input.album.trim() : '';
  const title = normalizeMetadataText(requestedTitle);
  const artist = normalizeCacheArtist(requestedArtist);
  const album = normalizeMetadataText(requestedAlbum);
  const lyricsEnabled = input.lyricsEnabled === true;
  const lyricsText = lyricsEnabled && typeof input.lyricsText === 'string'
    ? input.lyricsText.slice(0, 1024 * 1024).trim()
    : '';
  const outputFormat = normalizeOutputFormat(input.outputFormat);
  const coverData = typeof input.coverData === 'string' && input.coverData.startsWith('data:image/')
    ? input.coverData.slice(0, 8 * 1024 * 1024)
    : '';
  const audioUrls = Array.isArray(input.audioUrls)
    ? input.audioUrls
      .filter(item => typeof item === 'string' && /^https?:\/\//.test(item))
      .slice(0, 24)
    : [];
  if (!trackId && !title && !artist && !album && !audioUrls.length) {
    throw new Error('trackId or metadata is required');
  }
  return {
    requestedQuality,
    quality,
    outputDir,
    trackId,
    requestedTitle,
    requestedArtist,
    requestedAlbum,
    title,
    artist,
    album,
    lyricsEnabled,
    lyricsText,
    outputFormat,
    coverData,
    audioUrls,
  };
}

function friendlyRestoreError(message, quality = '') {
  if (String(message).includes('No matching resourceId or chunkId')) {
    const label = quality === 'lossless' ? '\u65e0\u635f\u97f3\u8d28' : quality;
    return label
      ? `\u6c7d\u6c34\u5c1a\u672a\u751f\u6210\u5f53\u524d\u6b4c\u66f2\u7684${label}\u7f13\u5b58\uff0c\u672a\u627e\u5230\u5bf9\u5e94\u7684 chunkId`
      : '\u6c7d\u6c34\u5c1a\u672a\u751f\u6210\u5f53\u524d\u6b4c\u66f2\u7f13\u5b58\uff0c\u672a\u627e\u5230\u5bf9\u5e94\u7684 chunkId';
  }
  return message;
}

module.exports = {
  friendlyRestoreError,
  normalizeCacheQuality,
  normalizeOutputFormat,
  normalizeRestoreInput,
  requiredText,
};
