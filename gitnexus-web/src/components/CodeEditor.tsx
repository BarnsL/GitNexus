import { useEffect, useRef } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  Decoration,
  type DecorationSet,
} from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { getEditorLanguage } from '../lib/editor-languages';

/**
 * CodeMirror 6 host for the Code Inspector.
 *
 * Replaces the read-only react-syntax-highlighter viewer. Three behaviors the
 * highlighter gave for free are reimplemented explicitly here: absolute line
 * numbering for windowed reads, the cyan symbol band, and scroll-to-line.
 */

export interface EditorDiagnostic {
  /** 0-based absolute file line the diagnostic starts on. */
  line: number;
  endLine?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: 'tree-sitter' | 'language' | 'graph' | 'ai';
}

export interface CodeEditorProps {
  filePath: string;
  content: string;
  /** 0-based absolute index of the first rendered line (window offset). */
  firstLine: number;
  editable: boolean;
  /** 0-based absolute line range to band in cyan, or null. */
  highlightRange: { start: number; end: number } | null;
  diagnostics: EditorDiagnostic[];
  onChange: (next: string) => void;
  onSave?: () => void;
}

const setBandEffect = StateEffect.define<{ from: number; to: number } | null>();

const bandDecoration = Decoration.line({ class: 'gn-symbol-band' });

/** Cyan band marking the selected symbol's line range. */
const bandField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setBandEffect)) continue;
      const range = effect.value;
      if (!range) {
        next = Decoration.none;
        continue;
      }
      const builder = [];
      for (let line = range.from; line <= range.to; line += 1) {
        if (line < 1 || line > tr.state.doc.lines) continue;
        builder.push(bandDecoration.range(tr.state.doc.line(line).from));
      }
      next = Decoration.set(builder);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
  '&': { backgroundColor: '#0a0a10', color: '#d4d4d4', height: '100%' },
  '.cm-scroller': {
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    fontSize: '13px',
    lineHeight: '1.6',
  },
  '.cm-gutters': { backgroundColor: '#0a0a10', color: '#5a5a70', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
  '.gn-symbol-band': {
    backgroundColor: 'rgba(6, 182, 212, 0.14)',
    borderLeft: '3px solid #06b6d4',
  },
  '.cm-content': { caretColor: '#06b6d4' },
});

const toCmSeverity = (severity: EditorDiagnostic['severity']): Diagnostic['severity'] =>
  severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info';

export const CodeEditor = ({
  filePath,
  content,
  firstLine,
  editable,
  highlightRange,
  diagnostics,
  onChange,
  onSave,
}: CodeEditorProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // Create the view once. Content, language, and editability are swapped in
  // through transactions and compartments rather than by rebuilding.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          onSaveRef.current?.();
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers({
          // Windowed reads start partway into the file; the gutter must show
          // absolute file lines, not offsets into the fetched slice.
          formatNumber: (n) => String(firstLine + n),
        }),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
        lintGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        autocompletion(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bandField,
        theme,
        saveKeymap,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        languageCompartment.current.of([]),
        editableCompartment.current.of([
          EditorView.editable.of(editable),
          EditorState.readOnly.of(!editable),
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    // Exposed so tests can dispatch transactions directly.
    (view.dom as unknown as { __cmView: EditorView }).__cmView = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally created once; updates flow through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the document when the file or its fetched window changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === content) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
  }, [content, filePath]);

  // Load the language pack asynchronously so the editor renders immediately.
  useEffect(() => {
    let cancelled = false;
    void getEditorLanguage(filePath).then((extension: Extension | null) => {
      const view = viewRef.current;
      if (cancelled || !view) return;
      view.dispatch({
        effects: languageCompartment.current.reconfigure(extension ?? []),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.current.reconfigure([
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable),
      ]),
    });
  }, [editable]);

  // Band the selected symbol and scroll it into view. Absolute 0-based lines
  // are converted to view-relative 1-based lines here, which is the conversion
  // the old lineProps callback got wrong.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (!highlightRange) {
      view.dispatch({ effects: setBandEffect.of(null) });
      return;
    }

    const from = highlightRange.start - firstLine + 1;
    const to = highlightRange.end - firstLine + 1;
    view.dispatch({ effects: setBandEffect.of({ from, to }) });

    const target = Math.min(Math.max(from, 1), view.state.doc.lines);
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.doc.line(target).from, { y: 'center' }),
    });
  }, [highlightRange, firstLine, content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const lineCount = view.state.doc.lines;
    const mapped: Diagnostic[] = diagnostics.flatMap((d) => {
      const relative = Math.min(Math.max(d.line - firstLine + 1, 1), lineCount);
      const line = view.state.doc.line(relative);
      const endRelative = Math.min(
        Math.max((d.endLine ?? d.line) - firstLine + 1, relative),
        lineCount,
      );
      const endLine = view.state.doc.line(endRelative);
      return [
        {
          from: line.from,
          to: endLine.to,
          severity: toCmSeverity(d.severity),
          message: `[${d.source}] ${d.message}`,
        },
      ];
    });
    view.dispatch(setDiagnostics(view.state, mapped));
  }, [diagnostics, firstLine, content]);

  return <div ref={hostRef} className="h-full overflow-hidden" data-testid="code-editor" />;
};
