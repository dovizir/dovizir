import type { CertBand } from "@/lib/indexer";

/**
 * TWAB-vs-certification-floor meter with the 100/90 hysteresis bands.
 * The floor sits at 100% and the decertification edge (exitFloor) at 90% of the
 * track's floor reference; the fill is coloured by the on-chain-aligned band.
 * All numeric text renders LTR; the track itself is direction-neutral.
 */
export function CoverageMeter({
  twab,
  floor,
  band,
  twabDisplay,
  floorDisplay,
  labels,
}: {
  twab: string;
  floor: string;
  band: CertBand;
  twabDisplay: string;
  floorDisplay: string;
  labels: { floor: string; exit: string; twab: string };
}) {
  const twabN = BigInt(twab);
  const floorN = BigInt(floor) === 0n ? 1n : BigInt(floor);
  // Track spans 0..150% of floor; clamp the fill for display.
  const ratioBps = Number((twabN * 10_000n) / floorN); // 10000 == floor
  const clampedBps = Math.min(ratioBps, 15_000);
  const fillPct = (clampedBps / 15_000) * 100;
  const floorPct = (10_000 / 15_000) * 100; // 66.6%
  const exitPct = (9_000 / 15_000) * 100; // 60%

  const fill =
    band === "certified" ? "bg-success" : band === "at-risk" ? "bg-warning" : "bg-danger";

  return (
    <div>
      <div className="mb-xs flex items-center justify-between text-xs text-muted">
        <span>{labels.twab}</span>
        <span dir="ltr" className="font-medium text-foreground">
          {twabDisplay}
        </span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-pill bg-surface-alt">
        <div className={`h-full rounded-pill ${fill}`} style={{ width: `${fillPct}%` }} />
        {/* exit edge (90% of floor) */}
        <div
          className="absolute top-0 h-full w-px bg-warning/70"
          style={{ insetInlineStart: `${exitPct}%` }}
          title={labels.exit}
        />
        {/* certification floor (100%) */}
        <div
          className="absolute top-0 h-full w-0.5 bg-foreground/70"
          style={{ insetInlineStart: `${floorPct}%` }}
          title={labels.floor}
        />
      </div>
      <div className="mt-xs flex items-center justify-between text-[10px] text-muted">
        <span>{labels.exit}</span>
        <span dir="ltr">
          {labels.floor}: {floorDisplay}
        </span>
      </div>
    </div>
  );
}
