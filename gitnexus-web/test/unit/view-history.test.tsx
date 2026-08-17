import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AppStateProvider, useAppState, type ViewHistoryEntry } from '../../src/hooks/useAppState';

/**
 * View history is what makes Nexus-driven camera movement acceptable: the user
 * must always be able to get back to what they were reading.
 */

const wrapper = ({ children }: { children: ReactNode }) => (
  <AppStateProvider>{children}</AppStateProvider>
);

const entry = (n: number): Omit<ViewHistoryEntry, 'id' | 'label' | 'ts'> => ({
  camera: { x: n, y: n, ratio: 0.5, angle: 0 },
  selectedNodeId: `Function:src/a.ts:f${n}`,
  viewMode: 'force',
});

describe('view history', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    expect(result.current.viewHistory).toEqual([]);
  });

  it('pushes entries and pops them in LIFO order', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.pushViewHistory('first', entry(1));
      result.current.pushViewHistory('second', entry(2));
    });
    expect(result.current.viewHistory).toHaveLength(2);

    let popped: ViewHistoryEntry | null = null;
    act(() => {
      popped = result.current.popViewHistory();
    });

    expect(popped).not.toBeNull();
    expect(popped!.label).toBe('second');
    expect(popped!.camera).toMatchObject({ x: 2, y: 2 });
    expect(result.current.viewHistory).toHaveLength(1);
  });

  it('returns null when popping an empty stack', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    let popped: ViewHistoryEntry | null | undefined;
    act(() => {
      popped = result.current.popViewHistory();
    });

    expect(popped).toBeNull();
  });

  it('caps the stack, discarding the oldest entries', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      for (let i = 0; i < 25; i += 1) {
        result.current.pushViewHistory(`e${i}`, entry(i));
      }
    });

    expect(result.current.viewHistory).toHaveLength(20);
    expect(result.current.viewHistory[0].label).toBe('e5');
    expect(result.current.viewHistory[19].label).toBe('e24');
  });

  it('restoring an entry discards everything after it', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.pushViewHistory('a', entry(1));
      result.current.pushViewHistory('b', entry(2));
      result.current.pushViewHistory('c', entry(3));
    });

    const middleId = result.current.viewHistory[1].id;
    let restored: ViewHistoryEntry | null = null;
    act(() => {
      restored = result.current.restoreViewHistory(middleId);
    });

    expect(restored!.label).toBe('b');
    // Everything from 'b' onward is consumed; only 'a' remains.
    expect(result.current.viewHistory.map((e) => e.label)).toEqual(['a']);
  });

  it('returns null when restoring an unknown id and leaves the stack intact', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.pushViewHistory('a', entry(1));
    });

    let restored: ViewHistoryEntry | null | undefined;
    act(() => {
      restored = result.current.restoreViewHistory('vh-does-not-exist');
    });

    expect(restored).toBeNull();
    expect(result.current.viewHistory).toHaveLength(1);
  });

  it('preserves the view mode so a restore can reapply the layout first', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.pushViewHistory('tree view', { ...entry(1), viewMode: 'tree' });
    });

    expect(result.current.viewHistory[0].viewMode).toBe('tree');
  });

  it('clears the whole stack', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.pushViewHistory('a', entry(1));
      result.current.pushViewHistory('b', entry(2));
      result.current.clearViewHistory();
    });

    expect(result.current.viewHistory).toEqual([]);
  });
});
