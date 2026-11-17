import { ref } from 'vue';

/** Suite Media theme: dark by default in the room, light, or following the system. */
export type ThemeChoice = 'dark' | 'light' | 'auto';
export const themeChoices: ReadonlyArray<{ id: ThemeChoice; label: string }> = [
  { id: 'dark', label: 'Sombre' },
  { id: 'light', label: 'Clair' },
  { id: 'auto', label: 'Auto' },
];

const STORAGE_KEY = 'nino-theme';
const theme = ref<ThemeChoice>(readStored());

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'auto' ? value : 'dark';
  } catch { return 'dark'; }
}

function apply(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = choice;
  const dark = choice === 'dark' || (choice === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151513' : '#e7e4dd');
}

export function applyStoredTheme(): void {
  apply(theme.value);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (theme.value === 'auto') apply('auto'); });
}

export function useTheme() {
  function setTheme(choice: ThemeChoice): void {
    theme.value = choice;
    try { localStorage.setItem(STORAGE_KEY, choice); } catch { /* private mode: the choice lasts for this visit */ }
    apply(choice);
  }
  return { theme, setTheme };
}
