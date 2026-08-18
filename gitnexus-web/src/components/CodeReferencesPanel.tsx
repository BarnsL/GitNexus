import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Code,
  PanelLeftClose,
  PanelLeft,
  Trash2,
  X,
  Target,
  FileCode,
  Sparkles,
  MousePointerClick,
  Loader2,
  Save,
} from '@/lib/lucide-icons';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useAppState } from '../hooks/useAppState';
import { type GraphNode, getSyntaxLanguageFromFilename } from 'gitnexus-shared';
import { NODE_COLORS } from '../lib/constants';
import {
  readFile,
  writeFile,
  shaOfContent,
  fetchServerInfo,
  type ReadFileResult,
} from '../services/backend-client';
import { CodeEditor, type EditorDiagnostic } from './CodeEditor';
import { computeGraphAwareDiagnostics } from '../lib/diagnostics/graph-aware-source';
import { isEditingEnabledForRepo, setEditingEnabledForRepo } from '../lib/editing-preference';

/** Debounce before recomputing graph-aware diagnostics while typing. */
const DIAGNOSTIC_DEBOUNCE_MS = 400;
import { useTranslation } from 'react-i18next';

const getSyntaxLanguage = (filePath: string | undefined): string => {
  if (!filePath) return 'text';
  return getSyntaxLanguageFromFilename(filePath);
};

// Match the code theme used elsewhere in the app
const customTheme = {
  ...vscDarkPlus,
  'pre[class*="language-"]': {
    ...vscDarkPlus['pre[class*="language-"]'],
    background: '#0a0a10',
    margin: 0,
    padding: '12px 0',
    fontSize: '13px',
    lineHeight: '1.6',
  },
  'code[class*="language-"]': {
    ...vscDarkPlus['code[class*="language-"]'],
    background: 'transparent',
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
  },
};

export interface CodeReferencesPanelProps {
  onFocusNode: (nodeId: string) => void;
  /** Fired after a successful save so the caller can schedule a re-index. */
  onFileSaved?: (filePath: string) => void;
}

export const CodeReferencesPanel = ({ onFocusNode, onFileSaved }: CodeReferencesPanelProps) => {
  const { t } = useTranslation(['common', 'graph']);
  const {
    graph,
    selectedNode,
    codeReferences,
    removeCodeReference,
    clearCodeReferences,
    setSelectedNode,
    codeReferenceFocus,
    projectName,
    currentRepo,
  } = useAppState();

  const nodeById = useMemo(() => {
    if (!graph) return new Map<string, GraphNode>();
    return new Map(graph.nodes.map((n) => [n.id, n]));
  }, [graph]);

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [glowRefId, setGlowRefId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const refCardEls = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const glowTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (glowTimerRef.current) {
        window.clearTimeout(glowTimerRef.current);
        glowTimerRef.current = null;
      }
    };
  }, []);

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const saved = window.localStorage.getItem('gitnexus.codePanelWidth');
      const parsed = saved ? parseInt(saved, 10) : NaN;
      if (!Number.isFinite(parsed)) return 560; // increased default
      return Math.max(420, Math.min(parsed, 900));
    } catch {
      return 560;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem('gitnexus.codePanelWidth', String(panelWidth));
    } catch {
      // ignore
    }
  }, [panelWidth]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = { startX: e.clientX, startWidth: panelWidth };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev: MouseEvent) => {
        const state = resizeRef.current;
        if (!state) return;
        const delta = ev.clientX - state.startX;
        const next = Math.max(420, Math.min(state.startWidth + delta, 900));
        setPanelWidth(next);
      };

      const onUp = () => {
        resizeRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [panelWidth],
  );

  const aiReferences = useMemo(
    () => codeReferences.filter((r) => r.source === 'ai'),
    [codeReferences],
  );

  // When the user clicks a citation badge in chat, focus the corresponding snippet card:
  // - expand the panel if collapsed
  // - smooth-scroll the card into view
  // - briefly glow it for discoverability
  useEffect(() => {
    if (!codeReferenceFocus) return;

    // Ensure panel is expanded
    setIsCollapsed(false);

    const { filePath, startLine, endLine } = codeReferenceFocus;
    const target =
      aiReferences.find(
        (r) => r.filePath === filePath && r.startLine === startLine && r.endLine === endLine,
      ) ?? aiReferences.find((r) => r.filePath === filePath);

    if (!target) return;

    // Double rAF: wait for collapse state + list DOM to render.
    const rafIds: number[] = [];
    const outerRafId = requestAnimationFrame(() => {
      const innerRafId = requestAnimationFrame(() => {
        const el = refCardEls.current.get(target.id);
        if (!el) return;

        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setGlowRefId(target.id);

        if (glowTimerRef.current) {
          window.clearTimeout(glowTimerRef.current);
        }
        glowTimerRef.current = window.setTimeout(() => {
          setGlowRefId((prev) => (prev === target.id ? null : prev));
          glowTimerRef.current = null;
        }, 1200);
      });
      rafIds.push(innerRafId);
    });
    rafIds.push(outerRafId);

    return () => {
      rafIds.forEach((id) => cancelAnimationFrame(id));
    };
  }, [codeReferenceFocus, aiReferences]);

  // Snippet fetching for AI citation cards.
  //
  // This used to hard-code `content: null`, so the citation highlighter below
  // never rendered and every card fell through to "code not available". Each
  // reference now fetches a small window around its line range.
  const CITATION_CONTEXT_LINES = 3;

  interface Snippet {
    content: string;
    /** 0-based absolute line index of the first line in `content`. */
    start: number;
    totalLines: number;
  }

  const [snippets, setSnippets] = useState<Map<string, Snippet>>(new Map());
  const requestedSnippetIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pending = aiReferences.filter((ref) => !requestedSnippetIds.current.has(ref.id));
    if (pending.length === 0) return;

    let cancelled = false;
    for (const ref of pending) {
      requestedSnippetIds.current.add(ref.id);
    }

    void (async () => {
      for (const ref of pending) {
        const hasRange = typeof ref.startLine === 'number';
        const startLine = ref.startLine ?? 0;
        const endLine = ref.endLine ?? startLine;
        const windowStart = hasRange ? Math.max(0, startLine - CITATION_CONTEXT_LINES) : 0;
        try {
          const result = await readFile(ref.filePath, {
            ...(hasRange
              ? { startLine: windowStart, endLine: endLine + CITATION_CONTEXT_LINES }
              : {}),
            repo: currentRepo || projectName || undefined,
          });
          if (cancelled) return;
          setSnippets((prev) =>
            new Map(prev).set(ref.id, {
              content: result.content,
              start: result.startLine ?? windowStart,
              totalLines: result.totalLines,
            }),
          );
        } catch {
          if (cancelled) return;
          // Leave the entry absent so the card shows "code not available"
          // rather than an empty highlighter.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [aiReferences, currentRepo, projectName]);

  const refsWithSnippets = useMemo(() => {
    return aiReferences.map((ref) => {
      const snippet = snippets.get(ref.id);
      if (!snippet) {
        return {
          ref,
          content: null as string | null,
          start: 0,
          end: 0,
          highlightStart: 0,
          highlightEnd: 0,
          totalLines: 0,
        };
      }
      // highlightStart/highlightEnd are 0-based offsets *within the window*;
      // ref.startLine/endLine are 0-based absolute file lines.
      const startLine = ref.startLine ?? 0;
      const endLine = ref.endLine ?? startLine;
      return {
        ref,
        content: snippet.content,
        start: snippet.start,
        end: snippet.start + snippet.content.split('\n').length - 1,
        highlightStart: Math.max(0, startLine - snippet.start),
        highlightEnd: Math.max(0, endLine - snippet.start),
        totalLines: snippet.totalLines,
      };
    });
  }, [aiReferences, snippets]);

  // ── Editing state ─────────────────────────────────────────────────────────
  // The buffer is separate from the fetched content so an unsaved edit is not
  // lost when an unrelated re-render happens, and so `isDirty` is a real
  // comparison rather than a flag someone has to remember to reset.
  const [buffer, setBuffer] = useState<string>('');
  const [loadedSha, setLoadedSha] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverAllowsWrites, setServerAllowsWrites] = useState(false);
  const [editingPreferred, setEditingPreferred] = useState(false);

  // Editing requires BOTH the server policy and the per-repo preference. The
  // preference alone is not a security boundary.
  const editingEnabled = serverAllowsWrites && editingPreferred;

  useEffect(() => {
    setEditingPreferred(isEditingEnabledForRepo(currentRepo));
  }, [currentRepo]);

  useEffect(() => {
    let cancelled = false;
    fetchServerInfo()
      .then((info) => {
        if (!cancelled) setServerAllowsWrites(Boolean(info.fileWritesEnabled));
      })
      .catch(() => {
        if (!cancelled) setServerAllowsWrites(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedFilePath = selectedNode?.properties?.filePath;
  const selectedIsFile = selectedNode?.label === 'File' && !!selectedFilePath;
  const showSelectedViewer = !!selectedNode && !!selectedFilePath;
  const showCitations = aiReferences.length > 0;

  // Fetch file content from the server when a node with a filePath is selected.
  // For non-File nodes (functions, classes, etc.), fetch a buffer around the symbol
  // instead of the entire file. For File nodes, fetch the whole file.
  const CONTEXT_LINES = 50; // lines of context above and below the symbol

  const [fileResult, setFileResult] = useState<ReadFileResult | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const selectedViewerRef = useRef<HTMLDivElement>(null);

  const selectedFileContent = fileResult?.content;
  const fileStartLine = fileResult?.startLine ?? 0;

  // Reset the buffer and its concurrency baseline whenever new content loads.
  useEffect(() => {
    if (selectedFileContent === undefined) return;
    setBuffer(selectedFileContent);
    setSaveState('idle');
    setSaveError(null);
    void shaOfContent(selectedFileContent).then(setLoadedSha);
  }, [selectedFileContent, selectedFilePath]);

  const isDirty = selectedFileContent !== undefined && buffer !== selectedFileContent;

  /** 0-based absolute range of the selected symbol, for the cyan band. */
  const symbolRange = useMemo(() => {
    const start = selectedNode?.properties?.startLine;
    if (typeof start !== 'number') return null;
    const end = selectedNode?.properties?.endLine;
    // Graph lines are 1-based; the editor takes 0-based absolute lines.
    return { start: start - 1, end: (typeof end === 'number' ? end : start) - 1 };
  }, [selectedNode]);

  // Graph-aware diagnostics, debounced so they do not run on every keystroke.
  const [diagnostics, setDiagnostics] = useState<EditorDiagnostic[]>([]);
  useEffect(() => {
    if (!selectedFilePath) {
      setDiagnostics([]);
      return;
    }
    const timer = window.setTimeout(() => {
      setDiagnostics(computeGraphAwareDiagnostics(graph, selectedFilePath, buffer));
    }, DIAGNOSTIC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [graph, selectedFilePath, buffer]);

  const handleSave = useCallback(async () => {
    if (!selectedFilePath || loadedSha === null || !editingEnabled) return;
    setSaveState('saving');
    setSaveError(null);
    try {
      const result = await writeFile(selectedFilePath, buffer, loadedSha, {
        repo: currentRepo || projectName || undefined,
      });
      setLoadedSha(result.sha);
      setSaveState('saved');
      onFileSaved?.(selectedFilePath);
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    }
  }, [selectedFilePath, loadedSha, editingEnabled, buffer, currentRepo, projectName, onFileSaved]);

  useEffect(() => {
    if (!selectedFilePath) {
      setFileResult(null);
      return;
    }

    let cancelled = false;
    setIsLoadingFile(true);
    setFileResult(null);

    // Determine read range: full file for File nodes, buffered for symbols
    const startLine = selectedNode?.properties?.startLine as number | undefined;
    const endLine = selectedNode?.properties?.endLine as number | undefined;
    const isWholeFile = selectedIsFile || startLine === undefined;

    const options = isWholeFile
      ? {}
      : {
          startLine: Math.max(0, startLine - CONTEXT_LINES),
          endLine: (endLine ?? startLine) + CONTEXT_LINES,
        };

    // Prefer the repo path identity over the display name — duplicate display
    // names would otherwise resolve to the wrong repository's file (#2420).
    readFile(selectedFilePath, { ...options, repo: currentRepo || projectName || undefined })
      .then((result) => {
        if (!cancelled) {
          setFileResult(result);
          setIsLoadingFile(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFileResult(null);
          setIsLoadingFile(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedFilePath,
    selectedNode?.properties?.startLine,
    selectedNode?.properties?.endLine,
    selectedIsFile,
    projectName,
    currentRepo,
  ]);

  // Scroll to the selected node's startLine after content loads
  useEffect(() => {
    if (!selectedFileContent || !selectedNode?.properties?.startLine) return;
    const startLine = selectedNode.properties.startLine as number;

    // Double rAF: wait for SyntaxHighlighter to fully render before scrolling
    let cancelled = false;
    const outerRaf = requestAnimationFrame(() => {
      const innerRaf = requestAnimationFrame(() => {
        if (cancelled) return;
        const container = selectedViewerRef.current;
        if (!container) return;
        const lineEl =
          (container.querySelector(`[data-line-number="${startLine + 1}"]`) as HTMLElement) ??
          (container.querySelectorAll('.linenumber')[startLine] as HTMLElement);
        if (lineEl) {
          lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          // Fallback: estimate scroll position based on line height
          const lineHeight = 20.8; // 13px font * 1.6 line-height
          container.scrollTop = Math.max(0, startLine * lineHeight - container.clientHeight / 3);
        }
      });
      rafIds.push(innerRaf);
    });
    const rafIds = [outerRaf];
    return () => {
      cancelled = true;
      rafIds.forEach((id) => cancelAnimationFrame(id));
    };
  }, [selectedFileContent, selectedNode?.properties?.startLine]);

  if (isCollapsed) {
    return (
      <aside className="flex h-full w-12 flex-shrink-0 flex-col items-center gap-2 border-r border-border-subtle bg-surface py-3">
        <button
          onClick={() => setIsCollapsed(false)}
          className="rounded p-2 text-text-secondary transition-colors hover:bg-cyan-500/10 hover:text-cyan-400"
          title={t('graph:codePanel.expand')}
        >
          <PanelLeft className="h-5 w-5" />
        </button>
        <div className="my-1 h-px w-6 bg-border-subtle" />
        {showSelectedViewer && (
          <div className="rotate-90 text-[9px] font-medium tracking-wide whitespace-nowrap text-amber-400">
            {t('graph:codePanel.selected')}
          </div>
        )}
        {showCitations && (
          <div className="mt-4 rotate-90 text-[9px] font-medium tracking-wide whitespace-nowrap text-cyan-400">
            AI • {aiReferences.length}
          </div>
        )}
      </aside>
    );
  }

  return (
    <aside
      ref={(el) => {
        panelRef.current = el;
      }}
      className="relative flex h-full animate-slide-in flex-col border-r border-border-subtle bg-surface/95 shadow-2xl backdrop-blur-md"
      style={{ width: panelWidth }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={startResize}
        className="absolute top-0 right-0 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-cyan-500/25"
        title={t('graph:codePanel.dragResize')}
      />
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-subtle bg-gradient-to-r from-elevated/60 to-surface/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Code className="h-4 w-4 text-cyan-400" />
          <span className="text-sm font-semibold text-text-primary">
            {t('graph:codePanel.title')}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {showCitations && (
            <button
              onClick={() => clearCodeReferences()}
              className="rounded p-1.5 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
              title={t('graph:codePanel.clearCitations')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => setIsCollapsed(true)}
            className="rounded p-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
            title={t('common:actions.collapse')}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Top: Selected file viewer (when a node is selected) */}
        {showSelectedViewer && (
          <div className={`${showCitations ? 'h-[42%]' : 'flex-1'} flex min-h-0 flex-col`}>
            <div className="flex items-center gap-2 border-b border-amber-500/20 bg-gradient-to-r from-amber-500/8 to-orange-500/5 px-3 py-2">
              <div className="flex items-center gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/15 px-2 py-0.5">
                <MousePointerClick className="h-3 w-3 text-amber-400" />
                <span className="text-[10px] font-semibold tracking-wide text-amber-300 uppercase">
                  {t('graph:codePanel.selected')}
                </span>
              </div>
              <FileCode className="ml-1 h-3.5 w-3.5 text-amber-400/70" />
              <span className="flex-1 truncate font-mono text-xs text-text-primary">
                {selectedNode?.properties?.filePath?.split('/').pop() ??
                  selectedNode?.properties?.name}
              </span>
              {serverAllowsWrites ? (
                <button
                  onClick={() => {
                    const next = !editingPreferred;
                    setEditingPreferred(next);
                    setEditingEnabledForRepo(currentRepo, next);
                  }}
                  className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase transition-colors ${
                    editingEnabled
                      ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300 hover:bg-cyan-400/20'
                      : 'border-white/15 text-text-muted hover:border-cyan-300/40 hover:text-cyan-200'
                  }`}
                  title={
                    editingEnabled
                      ? t('graph:editor.disableEditing')
                      : t('graph:editor.enableEditing')
                  }
                >
                  {editingEnabled ? t('graph:editor.editing') : t('graph:editor.readOnly')}
                </button>
              ) : (
                <span
                  className="rounded-md border border-white/10 px-2 py-0.5 text-[10px] tracking-wide text-text-muted uppercase"
                  title={t('graph:editor.writesDisabled')}
                >
                  {t('graph:editor.readOnly')}
                </span>
              )}
              {editingEnabled && isDirty && (
                <button
                  onClick={handleSave}
                  disabled={saveState === 'saving'}
                  className="inline-flex items-center gap-1 rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-cyan-200 uppercase transition-colors hover:bg-cyan-400/20 disabled:opacity-60"
                  title={t('graph:editor.unsaved')}
                >
                  <Save className="h-3 w-3" />
                  {saveState === 'saving' ? t('graph:editor.saving') : t('graph:editor.save')}
                </button>
              )}
              {saveState === 'saved' && !isDirty && (
                <span className="text-[10px] tracking-wide text-emerald-300/80 uppercase">
                  {t('graph:editor.saved')}
                </span>
              )}
              <button
                onClick={() => setSelectedNode(null)}
                className="rounded p-1 text-text-muted transition-colors hover:bg-amber-500/10 hover:text-amber-400"
                title={t('graph:codePanel.clearSelection')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {saveError && (
              <div className="border-b border-red-500/25 bg-red-500/10 px-3 py-1.5 text-[11px] leading-4 text-red-200">
                {t('graph:editor.saveFailed', { message: saveError })}
              </div>
            )}
            <div ref={selectedViewerRef} className="min-h-0 flex-1 scrollbar-thin overflow-auto">
              {isLoadingFile ? (
                <div className="flex items-center justify-center gap-2 py-8 text-text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">{t('graph:codePanel.loadingSource')}</span>
                </div>
              ) : selectedFileContent ? (
                <CodeEditor
                  filePath={selectedFilePath ?? ''}
                  content={selectedFileContent}
                  firstLine={fileStartLine}
                  editable={editingEnabled}
                  highlightRange={symbolRange}
                  diagnostics={diagnostics}
                  onChange={setBuffer}
                  onSave={handleSave}
                />
              ) : (
                <div className="px-3 py-3 text-sm text-text-muted">
                  {selectedIsFile ? (
                    <>{t('graph:codePanel.codeNotAvailable', { path: selectedFilePath })}</>
                  ) : (
                    <>{t('graph:codePanel.selectFile')}</>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Divider between Selected viewer and AI refs (more visible) */}
        {showSelectedViewer && showCitations && (
          <div className="h-1.5 bg-gradient-to-r from-transparent via-border-subtle to-transparent" />
        )}

        {/* Bottom: AI citations list */}
        {showCitations && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* AI Citations Section Header */}
            <div className="flex items-center gap-2 border-b border-cyan-500/20 bg-gradient-to-r from-cyan-500/8 to-teal-500/5 px-3 py-2">
              <div className="flex items-center gap-1.5 rounded-md border border-cyan-500/25 bg-cyan-500/15 px-2 py-0.5">
                <Sparkles className="h-3 w-3 text-cyan-400" />
                <span className="text-[10px] font-semibold tracking-wide text-cyan-300 uppercase">
                  {t('graph:codePanel.aiCitations')}
                </span>
              </div>
              <span className="ml-1 text-xs text-text-muted">
                {t('graph:codePanel.references', { count: aiReferences.length })}
              </span>
            </div>
            <div className="min-h-0 flex-1 scrollbar-thin space-y-3 overflow-y-auto p-3">
              {refsWithSnippets.map(
                ({ ref, content, start, highlightStart, highlightEnd, totalLines }) => {
                  const nodeColor = ref.label
                    ? (NODE_COLORS as any)[ref.label] || '#6b7280'
                    : '#6b7280';
                  const hasRange = typeof ref.startLine === 'number';
                  const startDisplay = hasRange ? (ref.startLine ?? 0) + 1 : undefined;
                  const endDisplay = hasRange ? (ref.endLine ?? ref.startLine ?? 0) + 1 : undefined;
                  const language = getSyntaxLanguage(ref.filePath);

                  const isGlowing = glowRefId === ref.id;

                  return (
                    <div
                      key={ref.id}
                      ref={(el) => {
                        refCardEls.current.set(ref.id, el);
                      }}
                      className={[
                        'overflow-hidden rounded-xl border border-border-subtle bg-elevated transition-all',
                        isGlowing
                          ? 'animate-pulse shadow-[0_0_0_6px_rgba(34,211,238,0.14)] ring-2 ring-cyan-300/70'
                          : '',
                      ].join(' ')}
                    >
                      <div className="flex items-start gap-2 border-b border-border-subtle bg-surface/40 px-3 py-2">
                        <span
                          className="mt-0.5 flex-shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
                          style={{ backgroundColor: nodeColor, color: '#06060a' }}
                          title={ref.label ?? t('graph:codePanel.code')}
                        >
                          {ref.label ?? t('graph:codePanel.code')}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-text-primary">
                            {ref.name ?? ref.filePath.split('/').pop() ?? ref.filePath}
                          </div>
                          <div className="truncate font-mono text-[11px] text-text-muted">
                            {ref.filePath}
                            {startDisplay !== undefined && (
                              <span className="text-text-secondary">
                                {' '}
                                • L{startDisplay}
                                {endDisplay !== startDisplay ? `–${endDisplay}` : ''}
                              </span>
                            )}
                            {totalLines > 0 && (
                              <span className="text-text-muted">
                                {' '}
                                • {t('graph:codePanel.lines', { count: totalLines })}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {ref.nodeId && (
                            <button
                              onClick={() => {
                                const nodeId = ref.nodeId!;
                                // Sync selection + focus graph
                                if (graph) {
                                  const node = nodeById.get(nodeId);
                                  if (node) setSelectedNode(node);
                                }
                                onFocusNode(nodeId);
                              }}
                              className="rounded p-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
                              title={t('common:actions.focusInGraph')}
                            >
                              <Target className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            onClick={() => removeCodeReference(ref.id)}
                            className="rounded p-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
                            title={t('common:actions.remove')}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      <div className="overflow-x-auto">
                        {content ? (
                          <SyntaxHighlighter
                            language={language}
                            style={customTheme as any}
                            showLineNumbers
                            startingLineNumber={start + 1}
                            lineNumberStyle={{
                              minWidth: '3em',
                              paddingRight: '1em',
                              color: '#5a5a70',
                              textAlign: 'right',
                              userSelect: 'none',
                            }}
                            lineProps={(lineNumber) => {
                              const isHighlighted =
                                hasRange &&
                                lineNumber >= start + highlightStart + 1 &&
                                lineNumber <= start + highlightEnd + 1;
                              return {
                                style: {
                                  display: 'block',
                                  backgroundColor: isHighlighted
                                    ? 'rgba(6, 182, 212, 0.14)'
                                    : 'transparent',
                                  borderLeft: isHighlighted
                                    ? '3px solid #06b6d4'
                                    : '3px solid transparent',
                                  paddingLeft: '12px',
                                  paddingRight: '16px',
                                },
                              };
                            }}
                            wrapLines
                          >
                            {content}
                          </SyntaxHighlighter>
                        ) : (
                          <div className="px-3 py-3 text-sm text-text-muted">
                            {t('graph:codePanel.codeNotAvailable', { path: ref.filePath })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                },
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
