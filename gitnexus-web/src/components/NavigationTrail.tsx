import { useTranslation } from 'react-i18next';
import { ArrowLeft, X } from '@/lib/lucide-icons';
import { useAppState, type ViewHistoryEntry } from '../hooks/useAppState';

/**
 * Breadcrumb trail for Nexus-driven graph navigation.
 *
 * Nexus moves the camera on its own initiative, so the user needs a way back.
 * Renders nothing until there is history, so it stays out of the way during
 * ordinary manual exploration.
 */

interface NavigationTrailProps {
  onRestore: (entry: ViewHistoryEntry) => void;
}

/** Recent entries shown as chips; the rest stay reachable only via Back. */
const VISIBLE_CHIPS = 4;

export const NavigationTrail = ({ onRestore }: NavigationTrailProps) => {
  const { t } = useTranslation(['graph']);
  const { viewHistory, popViewHistory, restoreViewHistory, clearViewHistory } = useAppState();

  if (viewHistory.length === 0) return null;

  const recent = viewHistory.slice(-VISIBLE_CHIPS);

  const handleBack = () => {
    const entry = popViewHistory();
    if (entry) onRestore(entry);
  };

  const handleChip = (id: string) => {
    const entry = restoreViewHistory(id);
    if (entry) onRestore(entry);
  };

  return (
    <div
      className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border border-white/10 bg-black/70 px-2 py-1 backdrop-blur"
      aria-label={t('graph:navigationTrail.trail')}
    >
      <button
        type="button"
        onClick={handleBack}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-cyan-200 transition-colors hover:bg-cyan-400/10"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t('graph:navigationTrail.back')}
      </button>

      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {recent.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => handleChip(entry.id)}
            title={t('graph:navigationTrail.restore', { label: entry.label })}
            className="max-w-[11rem] shrink-0 truncate rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:border-cyan-300/50 hover:text-cyan-200"
          >
            {entry.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={clearViewHistory}
        title={t('graph:navigationTrail.clear')}
        className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:text-white"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">{t('graph:navigationTrail.clear')}</span>
      </button>
    </div>
  );
};
