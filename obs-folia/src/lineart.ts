// The non-Pixi half of Folia's line-art contract. Coordinates are in height
// units (1 = viewport height); x can exceed 1 for wide screens.
export type Point = [number, number];

export interface LinePath {
  points: Point[];
  width: number;
  alpha: number;
  delay: number;
  span: number;
  dash?: [number, number];
}

export interface LineNode {
  at: Point;
  size: number;
  delay: number;
  twinklePhase: number;
}

export interface LineArtSpec {
  paths: LinePath[];
  nodes: LineNode[];
}
