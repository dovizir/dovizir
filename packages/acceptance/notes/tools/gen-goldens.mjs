/**
 * Regenerates goldens/*.golden.json from @noble primitives ONLY — never from
 * any @dovizir/notes implementation. The committed goldens are the wire-format
 * ground truth both arms must converge on byte-for-byte.
 *
 *   node tools/gen-goldens.mjs
 *
 * Constants here MUST stay in sync with specs/goldens.spec.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "goldens");

const toHex = (b) => `0x${bytesToHex(b)}`;
const fromHex = (h) => hexToBytes(h.startsWith("0x") ? h.slice(2) : h);
const utf8 = (s) => new TextEncoder().encode(s);
const keccakHex = (b) => toHex(keccak_256(b));
const pub = (priv) => toHex(secp256k1.getPublicKey(fromHex(priv), true));
const u32be = (n) => fromHex(n.toString(16).padStart(8, "0"));
const u64be = (n) => fromHex(BigInt(n).toString(16).padStart(16, "0"));
const u256be = (v) => fromHex(v.toString(16).padStart(64, "0"));
const sign = (priv, digest) =>
  `0x${secp256k1.sign(digest, fromHex(priv)).toCompactHex()}`;

const HEX_RE = /^0x[0-9a-fA-F]+$/;
function canonical(v) {
  if (typeof v === "bigint") return JSON.stringify(`0x${v.toString(16)}`);
  if (typeof v === "string") return JSON.stringify(HEX_RE.test(v) ? v.toLowerCase() : v);
  if (v === null || typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

function cmpBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}
const pairHash = (a, b) =>
  cmpBytes(a, b) <= 0 ? keccak_256(concatBytes(a, b)) : keccak_256(concatBytes(b, a));

// ---- shared constants (mirror specs/support/fixtures.ts + goldens.spec.ts) ----
const SARRAF_PRIV = `0x${"22".repeat(32)}`;
const CARVER_PRIV = `0x${"33".repeat(32)}`;
const RECIPIENT_PRIV = `0x${"44".repeat(32)}`;
const SARRAF_PUB = pub(SARRAF_PRIV);
const CARVER_PUB = pub(CARVER_PRIV);
const RECIPIENT_PUB = pub(RECIPIENT_PRIV);

const TRANCHE = `0x${"01".repeat(32)}`;
const SALT = `0x${"feedface".repeat(8)}`;
const NOTE_EXPIRY = 1_777_003_600;
const CERT_EXPIRY = 1_777_007_200;

// ---- golden invoice ----
const invoice = {
  recipient: RECIPIENT_PUB,
  amount: 5_000_000n,
  nonce: `0x${"0badc0de".repeat(8)}`,
  memo: "tea ☕",
  createdAt: 1_776_999_700,
};
const invoiceCanonical = canonical(invoice);
const invoiceHash = keccakHex(utf8(invoiceCanonical));

// ---- golden member cert (identical to the fixture member cert) ----
const certUnsigned = {
  subject: CARVER_PUB,
  role: "member",
  sarraf: SARRAF_PUB,
  capLimit: 1_000_000_000n,
  expiry: CERT_EXPIRY,
  issuer: SARRAF_PUB,
};
const certPreimage = canonical(certUnsigned);
const certDigest = keccak_256(utf8(certPreimage));
const certSignature = sign(SARRAF_PRIV, certDigest);

// ---- golden 2-note batch + transcript-hash preimage ----
const denominations = [5_000_000n, 5_000_000n];
const serials = denominations.map((_, i) =>
  keccakHex(concatBytes(fromHex(SALT), u32be(i))),
);
const leaves = denominations.map((v, i) =>
  keccak_256(concatBytes(fromHex(serials[i]), u256be(v))),
);
const batchRoot = toHex(pairHash(leaves[0], leaves[1]));
// §5 amendment: the carver signs serial ‖ invoiceHash ‖ u64be(expiry) ‖ batchRoot.
const sigPreimage = toHex(
  concatBytes(fromHex(serials[0]), fromHex(invoiceHash), u64be(NOTE_EXPIRY), fromHex(batchRoot)),
);
const sigDigest = keccak_256(fromHex(sigPreimage));
const transcriptSignature = sign(CARVER_PRIV, sigDigest);

mkdirSync(outDir, { recursive: true });
const write = (name, data) => {
  writeFileSync(join(outDir, name), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote goldens/${name}`);
};

write("invoice.golden.json", {
  inputs: {
    recipient: RECIPIENT_PUB,
    amount: invoice.amount.toString(),
    nonce: invoice.nonce,
    memo: invoice.memo,
    createdAt: invoice.createdAt,
  },
  canonical: invoiceCanonical,
  hash: invoiceHash,
});

write("cert.golden.json", {
  inputs: {
    issuerPrivateKey: SARRAF_PRIV,
    subject: CARVER_PUB,
    role: "member",
    sarraf: SARRAF_PUB,
    capLimit: certUnsigned.capLimit.toString(),
    expiry: CERT_EXPIRY,
  },
  preimage: certPreimage,
  digest: toHex(certDigest),
  signature: certSignature,
});

write("transcript.golden.json", {
  inputs: {
    carverPrivateKey: CARVER_PRIV,
    trancheId: TRANCHE,
    batchSalt: SALT,
    denominations: denominations.map((d) => d.toString()),
    expiry: NOTE_EXPIRY,
    invoice: "see invoice.golden.json",
  },
  serials,
  leaves: leaves.map(toHex),
  batchRoot,
  invoiceHash,
  sigPreimage,
  sigDigest: toHex(sigDigest),
  signature: transcriptSignature,
});
