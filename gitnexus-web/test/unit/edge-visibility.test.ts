import { describe, expect, it } from 'vitest';
import { ALL_EDGE_TYPES, isRelationshipRendered, normalizeEdgeType } from '../../src/lib/constants';

describe('normalizeEdgeType', () => {
  it('passes through every renderable edge type unchanged', () => {
    for (const type of ALL_EDGE_TYPES) {
      expect(normalizeEdgeType(type)).toBe(type);
    }
  });

  it('maps the Kotlin/Java hierarchy edges onto their renderable equivalents', () => {
    expect(normalizeEdgeType('HAS_METHOD')).toBe('DEFINES');
    expect(normalizeEdgeType('HAS_PROPERTY')).toBe('CONTAINS');
  });

  it('returns null for a relationship with no renderable form', () => {
    expect(normalizeEdgeType('USES')).toBeNull();
    expect(normalizeEdgeType('ACCESSES')).toBeNull();
    expect(normalizeEdgeType('STEP_IN_PROCESS')).toBeNull();
  });
});

describe('isRelationshipRendered', () => {
  it('reports a visible renderable type as drawn', () => {
    expect(isRelationshipRendered('CALLS', ['CALLS', 'DEFINES'])).toBe(true);
  });

  it('reports a filtered-out renderable type as not drawn', () => {
    expect(isRelationshipRendered('CALLS', ['DEFINES'])).toBe(false);
  });

  it('follows the normalized type when filtering hierarchy edges', () => {
    expect(isRelationshipRendered('HAS_METHOD', ['DEFINES'])).toBe(true);
    expect(isRelationshipRendered('HAS_METHOD', ['CONTAINS'])).toBe(false);
  });

  it('treats a null filter as "no filter active"', () => {
    expect(isRelationshipRendered('CALLS', null)).toBe(true);
    expect(isRelationshipRendered('CALLS', undefined)).toBe(true);
  });

  it('reports a non-renderable relationship as not drawn even with no filter', () => {
    // This is the case that matters most: USES edges exist in the graph but
    // have no renderable form, so a caller must describe them as real but
    // hidden rather than claiming the relationship is absent.
    expect(isRelationshipRendered('USES', null)).toBe(false);
  });
});
