/**
 * Pure camera geometry helpers.
 *
 * Kept out of useSigma so they can be unit tested without instantiating Sigma
 * or a WebGL context.
 */

export interface Point {
  x: number;
  y: number;
}

export interface CameraTarget {
  x: number;
  y: number;
  ratio: number;
}

/**
 * Camera ratio floor. Sigma's ratio is "graph units visible", so a ratio at or
 * near zero zooms past any usable level; a single-point frame would otherwise
 * produce 0.
 */
export const MIN_FRAME_RATIO = 0.05;

/** Ratio used when every supplied point sits at the same coordinate. */
export const SINGLE_POINT_RATIO = 0.15;

/**
 * Compute the camera position and zoom that frames every supplied point.
 *
 * Returns null for an empty set so callers can no-op rather than animating the
 * camera to NaN.
 */
export const computeBoundingBoxCamera = (points: Point[], padding: number): CameraTarget | null => {
  if (points.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  // Every point was non-finite.
  if (minX === Infinity) return null;

  const span = Math.max(maxX - minX, maxY - minY);
  const ratio = span > 0 ? Math.max(MIN_FRAME_RATIO, (span / 2) * padding) : SINGLE_POINT_RATIO;

  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    ratio,
  };
};
