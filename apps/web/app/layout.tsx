import type { Metadata } from "next";
import { Inter, Roboto, Vazirmatn } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { dirOf } from "@/i18n/config";
import { Providers } from "./providers";
import { ReviewOverlay } from "@/components/review-overlay";
import "./globals.css";

// Design-system type: Roboto body, Inter headings, Vazirmatn for Farsi/RTL.
const roboto = Roboto({
  variable: "--font-roboto",
  weight: ["400", "500", "700"],
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const vazirmatn = Vazirmatn({
  variable: "--font-vazirmatn",
  subsets: ["arabic", "latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return { title: t("appName"), description: t("tagline") };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body
        className={`${roboto.variable} ${inter.variable} ${vazirmatn.variable} antialiased`}
      >
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>{children}</Providers>
          <ReviewOverlay />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
