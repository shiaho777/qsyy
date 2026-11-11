import { Star, Music, Sparkles, Moon, Sun, Heart, Waves, Flower2, Cloud, Zap } from 'lucide-react';
import type { IconNode } from 'lucide-react';

// Explicit imports keep the OBS bundle small (importing all of lucide-react
// pushes it over 1 MB). The names match Folia's line-art icon registry.
const ICONS = { Star, Music, Sparkles, Moon, Sun, Heart, Waves, Flower2, Cloud, Zap };
export const ICON_NAMES = Object.keys(ICONS);

export const resolveLucideIconNode = (name: string | null | undefined): IconNode | null => {
  if (!name) return null;
  const icon = (ICONS as Record<string, unknown>)[name] as
    { render?: (props: object, ref: null) => unknown } | undefined;
  if (!icon || typeof icon.render !== 'function') return null;
  try {
    const element = icon.render({}, null) as {
      props?: { iconNode?: unknown; icon?: { node?: unknown } };
    } | null;
    const node = element?.props?.iconNode ?? element?.props?.icon?.node;
    return Array.isArray(node) ? node as IconNode : null;
  } catch (_) {
    return null;
  }
};
