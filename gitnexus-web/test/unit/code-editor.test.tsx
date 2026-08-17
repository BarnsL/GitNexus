import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { CodeEditor, type EditorDiagnostic } from '../../src/components/CodeEditor';
import {
  EDITOR_LANGUAGE_IDS,
  editorLanguageIdFor,
  getEditorLanguage,
} from '../../src/lib/editor-languages';
import { SupportedLanguages } from 'gitnexus-shared';

const DOC = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

const viewOf = (container: HTMLElement): EditorView => {
  const dom = container.querySelector('.cm-editor') as unknown as { __cmView: EditorView } | null;
  if (!dom) throw new Error('editor did not mount');
  return dom.__cmView;
};

const renderEditor = (props: Partial<React.ComponentProps<typeof CodeEditor>> = {}) =>
  render(
    <CodeEditor
      filePath="src/a.ts"
      content={DOC}
      firstLine={0}
      editable={false}
      highlightRange={null}
      diagnostics={[]}
      onChange={vi.fn()}
      {...props}
    />,
  );

describe('editor language mapping', () => {
  it('covers every indexed language', () => {
    for (const lang of Object.values(SupportedLanguages)) {
      expect(EDITOR_LANGUAGE_IDS[lang as SupportedLanguages]).toBeTruthy();
    }
  });

  it('maps source files to their editor language id', () => {
    expect(editorLanguageIdFor('src/a.ts')).toBe('typescript');
    expect(editorLanguageIdFor('main.py')).toBe('python');
    expect(editorLanguageIdFor('Server.java')).toBe('java');
  });

  it('maps auxiliary file types the Inspector also opens', () => {
    expect(editorLanguageIdFor('package.json')).toBe('json');
    expect(editorLanguageIdFor('README.md')).toBe('markdown');
    expect(editorLanguageIdFor('config.yml')).toBe('yaml');
  });

  it('returns null for an unmapped extension rather than throwing', () => {
    expect(editorLanguageIdFor('notes.unknownext')).toBeNull();
  });

  it('resolves a real extension for a mapped language', async () => {
    await expect(getEditorLanguage('src/a.ts')).resolves.not.toBeNull();
  });

  it('degrades to plain text instead of failing for an unmapped file', async () => {
    await expect(getEditorLanguage('notes.unknownext')).resolves.toBeNull();
  });
});

describe('CodeEditor', () => {
  it('renders the supplied content', async () => {
    const { container } = renderEditor();
    await waitFor(() => expect(container.querySelector('.cm-content')).toBeTruthy());
    expect(viewOf(container).state.doc.toString()).toBe(DOC);
  });

  it('numbers lines from the window offset, not from 1', async () => {
    const { container } = renderEditor({ firstLine: 29 });
    await waitFor(() => expect(container.querySelector('.cm-gutters')).toBeTruthy());
    const gutter = container.querySelector('.cm-gutters')?.textContent ?? '';
    // First rendered line is absolute line 30 when the window starts at index 29.
    expect(gutter).toContain('30');
    expect(gutter).not.toMatch(/\b1\b\s*2\s*3\b/);
  });

  it('does not report changes while read-only', async () => {
    const onChange = vi.fn();
    const { container } = renderEditor({ editable: false, onChange });
    await waitFor(() => expect(container.querySelector('.cm-content')).toBeTruthy());

    const view = viewOf(container);
    expect(view.state.readOnly).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports edits through onChange when editable', async () => {
    const onChange = vi.fn();
    const { container } = renderEditor({ editable: true, onChange });
    await waitFor(() => expect(container.querySelector('.cm-content')).toBeTruthy());

    const view = viewOf(container);
    expect(view.state.readOnly).toBe(false);
    view.dispatch({ changes: { from: 0, insert: '// ' } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(`// ${DOC}`));
  });

  it('bands the symbol range, converting absolute lines against the window offset', async () => {
    // Window starts at absolute line 10; symbol occupies absolute lines 11-12,
    // which is relative lines 2-3. The old viewer got this conversion wrong.
    const { container } = renderEditor({
      firstLine: 10,
      highlightRange: { start: 11, end: 12 },
    });
    await waitFor(() => expect(container.querySelectorAll('.gn-symbol-band').length).toBe(2));
  });

  it('clears the band when no range is selected', async () => {
    const { container } = renderEditor({ highlightRange: null });
    await waitFor(() => expect(container.querySelector('.cm-content')).toBeTruthy());
    expect(container.querySelectorAll('.gn-symbol-band')).toHaveLength(0);
  });

  it('renders diagnostics tagged with their source', async () => {
    const diagnostics: EditorDiagnostic[] = [
      { line: 1, severity: 'warning', message: 'has 4 callers', source: 'graph' },
    ];
    const { container } = renderEditor({ diagnostics });
    await waitFor(() => expect(container.querySelector('.cm-lint-marker')).toBeTruthy());
  });
});
