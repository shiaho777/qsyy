// Tiny replacement for react-i18next in the standalone module.
export const useTranslation = () => ({
  t: (key: string) => (key === 'ui.waitingForMusic' ? '等待播放…' : key),
});
