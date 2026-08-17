"use client";

import { useCaptureJoinSarraf } from "@/lib/embedded/use-wallet";

/** Records ?sarraf=0x… from the entry link so onboarding binds to that Sarraf. */
export function JoinCapture() {
  useCaptureJoinSarraf();
  return null;
}
