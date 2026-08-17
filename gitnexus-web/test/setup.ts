import { beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

const I18N_LANGUAGE_STORAGE_KEY = 'gitnexus.lng';

function ensureStorage(name: 'localStorage' | 'sessionStorage') {
  const current = globalThis[name];
  if (
    current &&
    typeof current.getItem === 'function' &&
    typeof current.removeItem === 'function'
  ) {
    return;
  }

  const store = new Map<string, string>();
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

ensureStorage('localStorage');
ensureStorage('sessionStorage');
localStorage.removeItem(I18N_LANGUAGE_STORAGE_KEY);

// Reset storage between tests
beforeEach(() => {
  sessionStorage.removeItem('gitnexus-llm-settings');
  localStorage.removeItem('gitnexus-llm-settings'); // legacy key (migration)
  localStorage.removeItem('gitnexus-llm-settings-persistence');
  localStorage.removeItem(I18N_LANGUAGE_STORAGE_KEY);
});

// jsdom implements no layout, so CodeMirror's text measurement throws when it
// calls getClientRects on a Range. Provide the minimal surface it needs; the
// returned zero-size rects are fine because no test asserts on pixel geometry.
if (typeof Range !== 'undefined') {
  const emptyRect = (): DOMRect =>
    ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = function getClientRects() {
      const list: DOMRect[] = [];
      return Object.assign(list, {
        item: (i: number) => list[i] ?? null,
      }) as unknown as DOMRectList;
    };
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = emptyRect;
  }
}
