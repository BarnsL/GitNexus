import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PipelineProgress } from 'gitnexus-shared';
import { LoadingOverlay } from '../../src/components/LoadingOverlay';
import { i18nReady } from '../../src/i18n';

const progress = (overrides: Partial<PipelineProgress>): PipelineProgress => ({
  phase: 'extracting',
  percent: 0,
  message: 'Connecting...',
  ...overrides,
});

describe('LoadingOverlay', () => {
  beforeEach(async () => {
    await i18nReady;
  });

  it('keeps initial server validation free of premature progress copy', () => {
    render(<LoadingOverlay progress={progress({ detail: 'Validating server' })} />);

    expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
    expect(screen.queryByText('Validating server')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('shows progress after repository loading begins', () => {
    render(
      <LoadingOverlay
        progress={progress({
          percent: 50,
          message: 'Downloading graph...',
          detail: '10.0 MB downloaded',
        })}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Downloading graph...');
    expect(screen.getByRole('status')).toHaveTextContent('10.0 MB downloaded');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('shows a confirmed connection error without a zero-percent meter', () => {
    render(
      <LoadingOverlay
        progress={progress({
          phase: 'error',
          message: 'Failed to connect to server',
          detail: 'The requested repository or resource was not found.',
        })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to connect to server');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The requested repository or resource was not found.',
    );
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});
