import { RouterProvider } from "react-router-dom";
import { I18nProvider } from "@/i18n/provider";
import { Providers } from "@/providers";
import { ReviewOverlay } from "@/components/review-overlay";
import { router } from "@/router";

export function App() {
  return (
    <I18nProvider>
      <Providers>
        <RouterProvider router={router} />
        <ReviewOverlay />
      </Providers>
    </I18nProvider>
  );
}
