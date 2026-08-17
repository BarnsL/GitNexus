import { describe, expect, it } from 'vitest';
import { extractRuntimeActionMarkers } from '../../src/lib/runtime-action-marker';

describe('extractRuntimeActionMarkers', () => {
  it('extracts unique strict action IDs and removes their control syntax', () => {
    const parsed = extractRuntimeActionMarkers(
      'I can start it.\n\n[[runtime-action:runtime-aaaaaaaaaaaaaaaa]]\n[[runtime-action:runtime-aaaaaaaaaaaaaaaa]]',
    );

    expect(parsed.content).toBe('I can start it.');
    expect(parsed.actionIds).toEqual(['runtime-aaaaaaaaaaaaaaaa']);
  });

  it('ignores malformed, invented, and fenced markers', () => {
    const input = [
      '[[runtime-action:runtime-NOTSAFE]]',
      '```text',
      '[[runtime-action:runtime-bbbbbbbbbbbbbbbb]]',
      '```',
    ].join('\n');

    expect(extractRuntimeActionMarkers(input)).toEqual({ content: input, actionIds: [] });
  });
});
