import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '../../src/components/MarkdownRenderer';

vi.mock('../../src/components/RuntimeActionCard', () => ({
  RuntimeActionCard: ({ actionId }: { actionId: string }) => (
    <div data-testid="runtime-action-card">{actionId}</div>
  ),
}));

describe('MarkdownRenderer runtime actions', () => {
  it('hides strict control syntax and renders the confirmed action surface', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'I found a safe launch plan.\n\n[[runtime-action:runtime-aaaaaaaaaaaaaaaa]]'}
      />,
    );

    expect(screen.getByText('I found a safe launch plan.')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-action-card')).toHaveTextContent('runtime-aaaaaaaaaaaaaaaa');
    expect(container).not.toHaveTextContent('[[runtime-action:');
  });
});
