"use client";

/**
 * QA review overlay — element-anchored comments that post to a GitHub issue.
 *
 * Env-gated: renders only when NEXT_PUBLIC_SLOWCOOK_REVIEW === "1", so
 * production builds tree-shake it out. Points at the dovizir/dovizir QA-review
 * issue by default; a reviewer connects their GitHub in the overlay to submit.
 */
import dynamic from "next/dynamic";

// Load client-only; the overlay touches window/DOM on mount.
const SlowcookReviewOverlay = dynamic(
  () => import("@slowcook-ai/review-overlay/react").then((m) => m.SlowcookReviewOverlay),
  { ssr: false },
);

export function ReviewOverlay() {
  if (process.env.NEXT_PUBLIC_SLOWCOOK_REVIEW !== "1") return null;
  return (
    <SlowcookReviewOverlay
      owner={process.env.NEXT_PUBLIC_SLOWCOOK_OWNER ?? "dovizir"}
      repo={process.env.NEXT_PUBLIC_SLOWCOOK_REPO ?? "dovizir"}
      prNumber={Number(process.env.NEXT_PUBLIC_SLOWCOOK_PR_NUMBER ?? "24")}
      enabled
    />
  );
}
