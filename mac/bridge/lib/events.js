'use strict';

class DownloadEventBus {
  constructor({ logger } = {}) {
    this.clients = new Set();
    this.logger = logger || (() => {});
  }

  connect(response, request) {
    response.write('retry: 2000\n\nevent: ready\ndata: {"ok":true}\n\n');
    this.clients.add(response);
    request.on('close', () => this.clients.delete(response));
  }

  publish(event, input, jobId, detail = {}) {
    const payload = {
      jobId,
      trackId: typeof input?.trackId === 'string' ? input.trackId : '',
      title: typeof input?.title === 'string' ? input.title : '',
      artist: typeof input?.artist === 'string' ? input.artist : '',
      album: typeof input?.album === 'string' ? input.album : '',
      quality: typeof input?.quality === 'string' ? input.quality : '',
      cover: input?.cover || '',
      ...detail,
    };
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch (error) {
        this.clients.delete(client);
        this.logger('sse-client-write-error', { message: error?.message || String(error) });
      }
    }
  }

  heartbeat() {
    for (const client of this.clients) {
      try {
        client.write(': heartbeat\n\n');
      } catch (_) {
        this.clients.delete(client);
      }
    }
  }
}

module.exports = { DownloadEventBus };
