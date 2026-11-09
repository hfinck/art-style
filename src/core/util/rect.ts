import type { Rect } from '../plugin-api/types';

export const emptyRect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 });

export const isEmpty = (r: Rect): boolean => r.w <= 0 || r.h <= 0;

export function union(a: Rect, b: Rect): Rect {
  if (isEmpty(a)) return { ...b };
  if (isEmpty(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Clip to [0,width]×[0,height] and snap outward to whole pixels. */
export function clipToBounds(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Bounding box of a vertex list with `stride` floats per vertex (x, y first). */
export function boundsOf(vertices: ArrayLike<number>, stride: number): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < vertices.length; i += stride) {
    const x = vertices[i]!, y = vertices[i + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x0 > x1) return emptyRect();
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Triangle-strip quad covering [x, x+w] × [y, y+h] with attr = (0..1, 0..1). */
export function rectVertices(x: number, y: number, w: number, h: number): Float32Array {
  return new Float32Array([x, y, 0, 0, x + w, y, 1, 0, x, y + h, 0, 1, x + w, y + h, 1, 1]);
}

export function fullRect(width: number, height: number): Float32Array {
  return rectVertices(0, 0, width, height);
}
