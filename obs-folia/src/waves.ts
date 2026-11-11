// Ported geometry from Folia's lumiere/lineart/diagrams.ts:
// standingWave and waterline. Coordinates are in height units.
import type { LineArtSpec, Point } from './lineart';

export const standingWave = (x0: number, x1: number, y: number, amplitude: number, loops: number, phase = 0): LineArtSpec => ({
  paths: [-1, -0.5, 0.5, 1].map((k, j) => ({
    points: Array.from({ length: 121 }, (_, i) => {
      const t = i / 120;
      return [x0 + (x1 - x0) * t, y + Math.sin(t * loops * Math.PI + phase) * amplitude * k] as Point;
    }),
    width: 0.0012,
    alpha: 0.18 + Math.abs(k) * 0.12,
    delay: j * 0.06,
    span: 0.5,
  })),
  nodes: Array.from({ length: loops + 1 }, (_, i) => ({
    at: [x0 + ((x1 - x0) * i) / loops, y] as Point,
    size: 0.012,
    delay: 0.5,
    twinklePhase: i,
  })),
});

export const waterline = (aspect: number, y: number, amplitude: number, waves: number, phase = 0): LineArtSpec => ({
  paths: [{
    points: Array.from({ length: 121 }, (_, i) => {
      const x = (i / 120) * aspect;
      return [x, y + Math.sin((i / 120) * waves * Math.PI * 2 + phase) * amplitude] as Point;
    }),
    width: 0.0011,
    alpha: 0.16,
    delay: 0.1,
    span: 0.6,
  }],
  nodes: [],
});
