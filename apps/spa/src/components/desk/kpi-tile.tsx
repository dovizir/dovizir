/** A labelled metric tile for the desk dashboard. Numbers render LTR. */
export function KpiTile({
  label,
  value,
  unit,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : "text-foreground";
  return (
    <div className="rounded-lg bg-surface p-lg shadow-sm">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`mt-xs font-heading text-2xl font-bold ${toneClass}`} dir="ltr">
        {value}
        {unit ? <span className="ms-xs text-sm font-medium text-muted">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-xs text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
