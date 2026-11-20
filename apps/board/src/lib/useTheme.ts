import { useSyncExternalStore } from 'react';
import { getThemePreference, setThemePreference, subscribeTheme } from './theme';

export function useTheme() {
  const preference = useSyncExternalStore(subscribeTheme, getThemePreference);
  return { preference, setPreference: setThemePreference };
}
