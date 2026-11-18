// Ported from Folia (src/components/visualizer/fume/backgroundConfig.ts)
// AGPL-3.0. See ../../NOTICE.md and ../../LICENSE.
// Simplified for the standalone port: the host's VisualizerBackgroundConfig
// registry type is replaced by a local shape. The shared FluidBackground does
// not read this config (it has no geometric layer); fume's own canvas
// background honors disableGeometricBackground through fumeTuning instead.
import { DEFAULT_FUME_TUNING } from '../types';
import type { VisualizerSharedProps } from '../definition';

export interface VisualizerBackgroundConfig {
    common?: {
        disableGeometricBackground?: boolean;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export const fumeBackgroundConfig = (props: VisualizerSharedProps): VisualizerBackgroundConfig => {
    const background = (props.background ?? {}) as VisualizerBackgroundConfig;
    return {
        ...background,
        common: {
            ...background.common,
            disableGeometricBackground: Boolean(background.common?.disableGeometricBackground)
                || (props.fumeTuning?.disableGeometricBackground ?? DEFAULT_FUME_TUNING.disableGeometricBackground),
        },
    };
};