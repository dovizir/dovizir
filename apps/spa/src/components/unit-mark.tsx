/**
 * The denomination of an AMOUNT: the Dovizir mark followed by USDT.
 *
 * Two senses, two renderings — never interchange them:
 *   instrument   ("send hawala to anyone")      -> the word, from messages
 *   denomination ("your balance is ⟨mark⟩USDT") -> this component
 *
 * `onBrand` selects a silver mark for use on the blue balance card, where the
 * standard blue-gradient logo would be invisible against the background.
 */
export function UnitMark({ onBrand = false }: { onBrand?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-[0.2em] whitespace-nowrap" dir="ltr">
      <img
        src={onBrand ? "/logo-silver.svg" : "/logo.svg"}
        alt=""
        width="16"
        height="16"
        className="inline-block h-[0.85em] w-[0.85em] self-center"
      />
      <span>USDT</span>
    </span>
  );
}
