import fr from './locales/fr.json';
import en from './locales/en.json';

export type Lang = 'fr' | 'en';
export type DictKey = keyof typeof fr;

const DICTS: Record<Lang, Record<string, string>> = { fr, en };
const STORAGE_KEY = 'baromontres.lang';

let current: Lang = pickInitial();

function isEnPath(pathname: string): boolean {
  return pathname === '/en' || pathname.startsWith('/en/');
}

function pickInitial(): Lang {
  if (typeof window !== 'undefined' && isEnPath(window.location.pathname)) return 'en';
  if (typeof localStorage === 'undefined') return 'fr';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'fr' || stored === 'en') return stored;
  const nav = navigator.language?.toLowerCase() ?? '';
  return nav.startsWith('en') ? 'en' : 'fr';
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  applyDom();
  if (typeof window !== 'undefined') {
    const onEn = isEnPath(window.location.pathname);
    if (lang === 'en' && !onEn) window.location.assign('/en');
    else if (lang === 'fr' && onEn) window.location.assign('/');
  }
}

export function t(key: DictKey | string, lang: Lang = current): string {
  const dict = DICTS[lang];
  return dict[key] ?? DICTS.fr[key] ?? key;
}

export function applyDom(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.lang-switch button')) {
    const lang = btn.dataset.lang as Lang | undefined;
    btn.setAttribute('aria-pressed', lang === current ? 'true' : 'false');
  }
}

export function bindLangSwitch(onChange: () => void): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.lang-switch button')) {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang as Lang | undefined;
      if (!lang || lang === current) return;
      setLang(lang);
      onChange();
    });
  }
}
