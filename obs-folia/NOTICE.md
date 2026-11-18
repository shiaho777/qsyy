# Folia Tilt port

This directory is a separate, optional visualizer module. It contains code
copied and adapted from **Folia** (`chthollyphile/folia-major`), which is
licensed under **AGPL-3.0**.

Upstream: https://github.com/chthollyphile/folia-major

The main qsyy application is licensed under GPL-3.0 with an additional
non-commercial restriction. This module is kept in its own directory/page and
is **not** imported into the qsyy main frontend; it talks to qsyy through the
local HTTP API. Its own license is the AGPL-3.0 text in `LICENSE`.

If you redistribute a build of this page, keep this notice and the AGPL source
available.

---

## Cappella & Fume ports

Two more Folia lyric visualizers were ported into this module: **Cappella**
(chat-bubble conversation, `src/cappella/`) and **Fume** (full-song article
layout with a flying camera, `src/fume/`). Both are AGPL-3.0 like the rest of
this module. They are selected with `?mode=cappella` / `?mode=fume` (default
`tilt`) and are code-split so the Tilt page does not download them. Neither
mode pulls in three.js.

### Ported source paths (upstream `src/components/visualizer/…`)

Cappella (`src/cappella/`): `VisualizerCappella.tsx`, `CappellaMessageRow.tsx`,
`CappellaBubbleParts.tsx`, `cappellaTypes.ts`, `cappellaConstants.ts`,
`cappellaIntensity.ts`, `cappellaMessages.ts`, `cappellaMessageSenders.ts`,
`cappellaMessageLayout.ts`, `cappellaBubbleMetrics.ts`, `cappellaReveal.ts`,
`avatarImages.ts`, `emoImages.ts`, `tuning.ts`, `customPacks.ts`, `entry.tsx`,
plus the `avatar/` (15 png) and `emo/` (9 png) asset folders and their READMEs.

Fume (`src/fume/`): `VisualizerFume.tsx`, `useFumeCanvasStage.ts`,
`fumeArticleLayout.ts`, `fumeCamera.ts`, `fumeCameraStep.ts`, `fumeCanvasText.ts`,
`fumeTextMeasure.ts`, `fumeTextStyle.ts`, `fumeBlockFrame.ts`, `fumeReveal.ts`,
`fumeLiveRaster.ts`, `fumeStage.ts`, `fumeTypes.ts`, `fumeMath.ts`,
`FumeBackground.ts`, `backgroundConfig.ts`, `tuning.ts`, `entry.tsx`.

Shared host dependencies were replaced by local stand-ins in `src/`:
`colorMix.ts`, `textMeasureCache.ts`, `glowBlurQuantize.ts`,
`lyricRenderQuality.ts`, `wordColoring.ts`, `icons.tsx` (inline SVG in place of
lucide-react), and extensions to `types.ts`, `definition.ts`, `stubs.ts`,
`i18n.ts`. The lyric helpers (`graphemeTiming.ts`, `renderHints.ts`,
`fontStacks.ts`, `runtime.ts`) were already present from the Tilt port.

### Trimming / adaptation notes

- **Registration shells dropped.** Upstream `entry.tsx` files register modes via
  `defineVisualizer` (settings panels, quick controls, asset store). The port
  keeps only mode identity metadata; `main.tsx` lazily imports the components.
- **Tuning simplified.** `tuning.ts` in both modes drops the
  `defineVisualizerTuning` host machinery and exports the default tuning
  constant (field names and default values match upstream `src/types.ts`) plus
  a stored-value resolver.
- **Custom packs cut (Cappella).** `customPacks.ts` upstream persists
  user-uploaded emoji/avatar packs through host services + IndexedDB + a zustand
  store. None of that exists here, so custom packs are trimmed to no-ops and
  only the built-in `avatar/` and `emo/` assets are used. A `custom` source
  falls back to `builtin`.
- **Render quality / glow.** The host's global render-scale setting and the
  Linux glyph-cache Lab switch are absent; the port renders at 1× (per-mode
  override honored, capped at 3× DPR) and always quantizes glow blur to whole
  pixels. `isGlowBlurQuantized()` returns false, so live text draws directly.
- **Fume background.** `FumeBackground.ts` (geometric canvas shapes) is kept and
  wired as an optional in-canvas background. Upstream defaults it OFF
  (`disableGeometricBackground: true`); the port follows that and exposes
  `?fumeBg=1` to turn it on. Otherwise the shared `FluidBackground` remains the
  backdrop for every mode. `backgroundConfig.ts` is kept with a local config
  shape (the host background registry type is not ported).
- **i18n.** `react-i18next` is replaced by the local `i18n.ts`; new keys
  (`ui.noTrack`) carry Chinese copy.

### Asset attribution (Cappella avatar / emo images)

Transcribed from upstream `cappella/avatar/README.md` and `cappella/emo/README.md`:

- The pictured character is Folia's personification (**folia-chan**); any
  resemblance to existing characters is coincidental.
- All avatar and emoji images are **AI-generated** (GPT Image2 model), not works
  of human artists.
- Per the upstream disclaimer, these images are **not bound by the repository's
  AGPL-3.0 code license**: because they are AI-generated rather than created by
  human artists, they are not covered by traditional copyright, and anyone may
  freely use, modify, and distribute them. (This is the upstream project's
  stated position, reproduced here for attribution.)
- Upstream salutes the human artists whose uploaded works made these generations
  possible, and encourages respecting real artists and their work.
- Built-in assets are loaded at runtime via Vite `import.meta.glob`; user-uploaded
  custom packs (stored in IndexedDB upstream) are not part of this port.
