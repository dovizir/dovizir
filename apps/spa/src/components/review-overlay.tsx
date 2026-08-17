import { lazy, Suspense } from "react";

/**
 * QA review overlay — element-anchored comments that post to a GitHub issue.
 * Env-gated: renders only when VITE_SLOWCOOK_REVIEW === "1", so production
 * builds tree-shake it out. (Ported from next/dynamic to React.lazy for Vite.)
 */
const SlowcookReviewOverlay = lazy(() =>
  import("@slowcook-ai/review-overlay/react").then((m) => ({
    default: m.SlowcookReviewOverlay,
  })),
);

export function ReviewOverlay() {
  if (import.meta.env.VITE_SLOWCOOK_REVIEW !== "1") return null;
  return (
    <Suspense fallback={null}>
      <SlowcookReviewOverlay
        owner={import.meta.env.VITE_SLOWCOOK_OWNER ?? "dovizir"}
        repo={import.meta.env.VITE_SLOWCOOK_REPO ?? "dovizir"}
        prNumber={Number(import.meta.env.VITE_SLOWCOOK_PR_NUMBER ?? "24")}
        enabled
      />
    </Suspense>
  );
}
