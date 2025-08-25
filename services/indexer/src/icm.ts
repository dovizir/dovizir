export function ageWeight(ageSec: number, tauSec = 30*24*3600) {
  return Math.min(1, ageSec / tauSec);
}
// placeholder shape—wire real inputs later
export function creditRateBps({ volScore, collatScore, penaltyDefault=0, penaltyBreach=0, custodianAdj=0 }: {
  volScore: number; collatScore: number; penaltyDefault?: number; penaltyBreach?: number; custodianAdj?: number;
}) {
  const base = 25 * (0.5*volScore + 0.3*collatScore + 0.2);
  const rate = Math.max(0, Math.min(25, base - penaltyDefault - penaltyBreach + custodianAdj));
  return Math.round(rate*100); // bps
}
