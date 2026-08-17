import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HelpPanel } from '../../src/components/HelpPanel';
import { StatusBar } from '../../src/components/StatusBar';

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => ({ graph: null, graphMode: 'full', progress: null }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('product promotion surfaces', () => {
  it('does not render sponsor or upstream repository links', () => {
    render(
      <>
        <StatusBar />
        <HelpPanel isOpen onClose={vi.fn()} nodeCount={0} edgeCount={0} />
      </>,
    );

    expect(screen.queryByRole('link', { name: 'graph:statusBar.sponsor' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'help:docsGithub' })).not.toBeInTheDocument();
    expect(
      document.querySelector('a[href="https://github.com/sponsors/abhigyanpatwari"]'),
    ).toBeNull();
    expect(
      document.querySelector('a[href="https://github.com/abhigyanpatwari/GitNexus"]'),
    ).toBeNull();
  });
});
