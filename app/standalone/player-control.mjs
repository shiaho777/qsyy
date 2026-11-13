// OBS-side player commands. The page that owns the <audio> element polls this
// expiring log; validation lives here so the HTTP handler stays thin and the
// replay/expiry rules are testable without booting the server.

export const PLAYER_ACTIONS = Object.freeze([
  'toggle', 'play', 'pause', 'next', 'prev', 'seek', 'volume', 'shuffle', 'repeat', 'jump',
]);

const ACTION_SET = new Set(PLAYER_ACTIONS);

const normalizeValue = (action, rawValue) => {
  if (action === 'seek' || action === 'volume' || action === 'jump') {
    const number = Number(rawValue);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  }
  if (action === 'shuffle') return Boolean(rawValue);
  if (action === 'repeat') {
    return rawValue === 'off' || rawValue === 'all' || rawValue === 'one' ? rawValue : undefined;
  }
  return undefined;
};

export function createPlayerControlHub({ ttl = 15000, limit = 64, now = Date.now } = {}) {
  let seq = 0;
  let commands = [];

  const prune = () => {
    const cutoff = now() - ttl;
    while (commands.length && commands[0].at < cutoff) commands.shift();
  };

  return {
    get seq() { return seq; },
    push(action, rawValue) {
      const cleanAction = String(action || '');
      if (!ACTION_SET.has(cleanAction)) return null;
      const value = normalizeValue(cleanAction, rawValue);
      if (value === undefined && (cleanAction === 'seek' || cleanAction === 'volume'
        || cleanAction === 'jump' || cleanAction === 'repeat')) return null;
      const command = { seq: ++seq, action: cleanAction, value, at: now() };
      commands.push(command);
      if (commands.length > limit) commands.splice(0, commands.length - limit);
      return command;
    },
    pending(since) {
      prune();
      return commands.filter(command => command.seq > since);
    },
  };
}
