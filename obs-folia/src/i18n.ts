// Tiny replacement for react-i18next in the standalone module.
const MESSAGES: Record<string, string> = {
  'ui.waitingForMusic': '等待播放…',
  'ui.noTrack': '未在播放',
};

export const useTranslation = () => ({
  t: (key: string) => MESSAGES[key] ?? key,
});