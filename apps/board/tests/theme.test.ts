// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let systemDark = false;
let mediaEvents: EventTarget;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '<meta name="theme-color" content="#f5f5f5">';
  systemDark = false;
  mediaEvents = new EventTarget();
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return systemDark;
    },
    addEventListener: mediaEvents.addEventListener.bind(mediaEvents),
    removeEventListener: mediaEvents.removeEventListener.bind(mediaEvents),
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function changeSystem(dark: boolean) {
  systemDark = dark;
  mediaEvents.dispatchEvent(new Event('change'));
}
it.each([null, 'invalid'])('defaults to system with stored value %s', async (stored) => {
  if (stored) localStorage.setItem('atlas.theme', stored);
  systemDark = true;
  const theme = await import('../src/lib/theme');
  theme.initializeTheme();
  expect(theme.getThemePreference()).toBe('system');
  expect(document.documentElement.dataset.theme).toBe('dark');
  changeSystem(false);
  expect(document.documentElement.dataset.theme).toBe('light');
});
it('keeps an override until System is selected again and persists preference', async () => {
  systemDark = true;
  const theme = await import('../src/lib/theme');
  theme.initializeTheme();
  theme.setThemePreference('light');
  changeSystem(false);
  changeSystem(true);
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.getItem('atlas.theme')).toBe('light');
  theme.setThemePreference('system');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.style.colorScheme).toBe('dark');
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
    '#101010',
  );
});
it('loads a persisted override and initializes once', async () => {
  localStorage.setItem('atlas.theme', 'dark');
  const theme = await import('../src/lib/theme');
  theme.initializeTheme();
  theme.initializeTheme();
  expect(theme.getThemePreference()).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  const notify = vi.fn();
  const unsubscribe = theme.subscribeTheme(notify);
  theme.setThemePreference('light');
  expect(notify).toHaveBeenCalledTimes(1);
  unsubscribe();
  theme.setThemePreference('dark');
  expect(notify).toHaveBeenCalledTimes(1);
});
it('supports startup and switching when storage access throws', async () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('blocked');
  });
  const theme = await import('../src/lib/theme');
  expect(() => theme.initializeTheme()).not.toThrow();
  expect(() => theme.setThemePreference('dark')).not.toThrow();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(theme.getThemePreference()).toBe('dark');
});
it('retains a session override when writing storage throws', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  const theme = await import('../src/lib/theme');
  theme.initializeTheme();
  theme.setThemePreference('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
});
it('falls back to light without system detection', async () => {
  vi.stubGlobal('matchMedia', undefined);
  const theme = await import('../src/lib/theme');
  theme.initializeTheme();
  expect(document.documentElement.dataset.theme).toBe('light');
});
