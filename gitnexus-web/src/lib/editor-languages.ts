/**
 * CodeMirror language resolution.
 *
 * `getSyntaxLanguageFromFilename` in gitnexus-shared returns Prism identifiers,
 * which CodeMirror does not understand. This module is the translation layer.
 *
 * Every language pack is imported dynamically so the editor's grammar payload
 * is not part of the initial bundle, and a missing optional package degrades to
 * plain text rather than breaking the editor.
 */

import type { Extension } from '@codemirror/state';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';

/**
 * Every indexed language mapped to an editor language id.
 *
 * `satisfies Record<SupportedLanguages, string>` matches the convention in
 * language-detection.ts: adding a member to the enum is a compile error until
 * the editor mapping is updated too.
 */
export const EDITOR_LANGUAGE_IDS = {
  [SupportedLanguages.JavaScript]: 'javascript',
  [SupportedLanguages.TypeScript]: 'typescript',
  [SupportedLanguages.Python]: 'python',
  [SupportedLanguages.Java]: 'java',
  [SupportedLanguages.C]: 'c',
  [SupportedLanguages.CPlusPlus]: 'cpp',
  [SupportedLanguages.CSharp]: 'csharp',
  [SupportedLanguages.Go]: 'go',
  [SupportedLanguages.Ruby]: 'ruby',
  [SupportedLanguages.Rust]: 'rust',
  [SupportedLanguages.PHP]: 'php',
  [SupportedLanguages.Kotlin]: 'kotlin',
  [SupportedLanguages.Swift]: 'swift',
  [SupportedLanguages.Dart]: 'dart',
  [SupportedLanguages.Vue]: 'vue',
  [SupportedLanguages.Cobol]: 'cobol',
} satisfies Record<SupportedLanguages, string>;

/** Non-source file types the Inspector also opens. */
const AUXILIARY_EDITOR_IDS: Record<string, string> = {
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  xml: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
};

/**
 * Languages served by a first-class CodeMirror package versus a legacy
 * StreamLanguage mode. Legacy modes give highlighting and indentation but not
 * the richer features (folding by syntax tree, completion) of a real grammar.
 */
const LEGACY_MODES: Record<string, { file: string; export: string }> = {
  csharp: { file: 'clike', export: 'csharp' },
  ruby: { file: 'ruby', export: 'ruby' },
  kotlin: { file: 'clike', export: 'kotlin' },
  swift: { file: 'swift', export: 'swift' },
  dart: { file: 'clike', export: 'dart' },
  cobol: { file: 'cobol', export: 'cobol' },
  shell: { file: 'shell', export: 'shell' },
};

/** Editor language ids that have a bundled grammar of some kind. */
export const SUPPORTED_EDITOR_LANGUAGE_IDS = new Set([
  ...Object.values(EDITOR_LANGUAGE_IDS),
  ...Object.values(AUXILIARY_EDITOR_IDS),
]);

/** Resolve a file path to an editor language id, or null when unmapped. */
export const editorLanguageIdFor = (filePath: string): string | null => {
  const lang = getLanguageFromFilename(filePath);
  if (lang) return EDITOR_LANGUAGE_IDS[lang];

  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext && ext in AUXILIARY_EDITOR_IDS) return AUXILIARY_EDITOR_IDS[ext];

  const basename = filePath.split(/[/\\]/).pop() ?? '';
  if (basename === 'Dockerfile' || basename === 'Makefile') return 'shell';

  return null;
};

const loadFirstClass = async (id: string): Promise<Extension | null> => {
  switch (id) {
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({
        jsx: true,
        typescript: true,
      });
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'java':
      return (await import('@codemirror/lang-java')).java();
    case 'c':
    case 'cpp':
      return (await import('@codemirror/lang-cpp')).cpp();
    case 'go':
      return (await import('@codemirror/lang-go')).go();
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust();
    case 'php':
      return (await import('@codemirror/lang-php')).php();
    case 'vue':
      return (await import('@codemirror/lang-vue')).vue();
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'html':
      return (await import('@codemirror/lang-html')).html();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql();
    default:
      return null;
  }
};

const loadLegacy = async (id: string): Promise<Extension | null> => {
  const entry = LEGACY_MODES[id];
  if (!entry) return null;
  const { StreamLanguage } = await import('@codemirror/language');
  const mod: Record<string, unknown> = await import(
    /* @vite-ignore */ `@codemirror/legacy-modes/mode/${entry.file}`
  );
  const mode = mod[entry.export];
  if (!mode) return null;
  return StreamLanguage.define(mode as never);
};

/**
 * Load the CodeMirror extension for a file, or null when the language has no
 * bundled grammar. A null result means plain text with editing still available,
 * never a failed editor.
 */
export const getEditorLanguage = async (filePath: string): Promise<Extension | null> => {
  const id = editorLanguageIdFor(filePath);
  if (!id) return null;

  try {
    const firstClass = await loadFirstClass(id);
    if (firstClass) return firstClass;
    return await loadLegacy(id);
  } catch {
    // A grammar package that fails to load must not take the editor with it.
    return null;
  }
};
