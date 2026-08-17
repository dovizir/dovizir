// Compatibility shim: the Next app's components import hooks from "next-intl".
// vite.config aliases "next-intl" → this file so those imports resolve to
// use-intl (next-intl's framework-agnostic core, identical hook API). The
// provider (NextIntlClientProvider) is replaced by I18nProvider at the app root,
// so it is intentionally not re-exported here.
export {
  useTranslations,
  useLocale,
  useFormatter,
  useNow,
  useMessages,
  useTimeZone,
} from "use-intl";
