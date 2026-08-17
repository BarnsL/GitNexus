import { describe, expect, it } from 'vitest';
import {
  computeBoundingBoxCamera,
  MIN_FRAME_RATIO,
  SINGLE_POINT_RATIO,
} from '../../src/lib/camera-geometry';

describe('computeBoundingBoxCamera', () => {
  it('centres on the midpoint of the supplied points', () => {
    const result = computeBoundingBoxCamera(
      [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ],
      1,
    );
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(5);
    expect(result!.y).toBeCloseTo(10);
  });

  it('scales the ratio to the larger dimension, so wide and tall frame alike', () => {
    const wide = computeBoundingBoxCamera(
      [
        { x: 0, y: 0 },
        { x: 100, y: 1 },
      ],
      1,
    );
    const tall = computeBoundingBoxCamera(
      [
        { x: 0, y: 0 },
        { x: 1, y: 100 },
      ],
      1,
    );
    expect(wide!.ratio).toBeCloseTo(tall!.ratio);
  });

  it('grows the ratio with padding so framed nodes are not flush to the edge', () => {
    const tight = computeBoundingBoxCamera(
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      1,
    );
    const padded = computeBoundingBoxCamera(
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      1.5,
    );
    expect(padded!.ratio).toBeGreaterThan(tight!.ratio);
  });

  it('uses a usable ratio for a single point instead of zero', () => {
    const result = computeBoundingBoxCamera([{ x: 4, y: 4 }], 1);
    expect(result).toMatchObject({ x: 4, y: 4, ratio: SINGLE_POINT_RATIO });
  });

  it('uses a usable ratio when every point is identical', () => {
    const result = computeBoundingBoxCamera(
      [
        { x: 2, y: 2 },
        { x: 2, y: 2 },
      ],
      1,
    );
    expect(result!.ratio).toBe(SINGLE_POINT_RATIO);
  });

  it('never returns a ratio below the floor', () => {
    const result = computeBoundingBoxCamera(
      [
        { x: 0, y: 0 },
        { x: 0.0001, y: 0.0001 },
      ],
      1,
    );
    expect(result!.ratio).toBeGreaterThanOrEqual(MIN_FRAME_RATIO);
  });

  it('returns null for an empty set rather than animating to NaN', () => {
    expect(computeBoundingBoxCamera([], 1)).toBeNull();
  });

  it('ignores non-finite coordinates', () => {
    const result = computeBoundingBoxCamera(
      [
        { x: 0, y: 0 },
        { x: Number.NaN, y: Number.POSITIVE_INFINITY },
        { x: 10, y: 10 },
      ],
      1,
    );
    expect(result!.x).toBeCloseTo(5);
    expect(result!.y).toBeCloseTo(5);
  });

  it('returns null when every coordinate is non-finite', () => {
    expect(computeBoundingBoxCamera([{ x: Number.NaN, y: Number.NaN }], 1)).toBeNull();
  });
});
