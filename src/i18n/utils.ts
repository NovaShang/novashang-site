import { ui, defaultLang, type Lang, type UIKey } from './ui';

export function getLangFromUrl(url: URL): Lang {
  const seg = url.pathname.split('/').filter(Boolean)[0];
  if (seg === 'zh' || seg === 'en') return seg;
  return defaultLang;
}

export function useTranslations(lang: Lang) {
  return function t(key: UIKey): string {
    return (ui[lang] as Record<UIKey, string>)[key] ?? (ui[defaultLang] as Record<UIKey, string>)[key];
  };
}

export function localizedPath(path: string, lang: Lang): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (clean === '/') return `/${lang}/`;
  return `/${lang}${clean}`;
}

export function switchLangPath(currentPath: string, currentLang: Lang, targetLang: Lang): string {
  const re = new RegExp(`^/${currentLang}(/|$)`);
  if (re.test(currentPath)) {
    return currentPath.replace(re, `/${targetLang}$1`);
  }
  return `/${targetLang}/`;
}

export function isHomePath(pathname: string, lang: Lang): boolean {
  return pathname === `/${lang}` || pathname === `/${lang}/`;
}
