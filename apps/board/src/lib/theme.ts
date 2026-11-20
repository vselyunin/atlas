export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const storageKey = 'atlas.theme';
let preference: ThemePreference = 'system';
let media: MediaQueryList | undefined;
let initialized = false;
const listeners = new Set<() => void>();

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function applyTheme() {
  const resolved: ResolvedTheme =
    preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.documentElement.style.removeProperty('background-color');
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#101010' : '#f5f5f5');
}

export function initializeTheme(): void {
  if (initialized) return;
  initialized = true;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (isPreference(stored)) preference = stored;
  } catch {
    // Browser storage can be blocked; the session still supports theme changes.
  }
  if (typeof window.matchMedia === 'function') {
    media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', onSystemChange);
  }
  applyTheme();
}

function onSystemChange() {
  if (preference === 'system') applyTheme();
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(value: ThemePreference): void {
  initializeTheme();
  preference = value;
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    // Keep the in-memory preference when saving is unavailable.
  }
  applyTheme();
  listeners.forEach((listener) => listener());
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => media?.removeEventListener('change', onSystemChange));
}
