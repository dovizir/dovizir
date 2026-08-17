import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { IntlProvider } from "use-intl";
import {
  defaultLocale,
  dirOf,
  isLocale,
  LOCALE_COOKIE,
  LOCALE_STORAGE,
  type Locale,
} from "./config";
import { messagesFor } from "./messages";

type LocaleCtx = { locale: Locale; setLocale: (l: Locale) => void };
const LocaleContext = createContext<LocaleCtx>({ locale: defaultLocale, setLocale: () => {} });

/** Locale switcher hook (replaces next-intl's server cookie flow). */
export function useLocaleSwitch(): LocaleCtx {
  return useContext(LocaleContext);
}

function readInitialLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const stored = window.localStorage.getItem(LOCALE_STORAGE);
  if (isLocale(stored)) return stored;
  const cookie = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${LOCALE_COOKIE}=`))
    ?.split("=")[1];
  if (isLocale(cookie)) return cookie;
  // Default to English; do NOT auto-switch to the visitor's browser language.
  // A user's explicit choice is honoured above (localStorage/cookie).
  return defaultLocale;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dirOf(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    window.localStorage.setItem(LOCALE_STORAGE, next);
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setLocaleState(next);
  }, []);

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <IntlProvider locale={locale} messages={messagesFor(locale)} timeZone="UTC">
        {children}
      </IntlProvider>
    </LocaleContext.Provider>
  );
}
