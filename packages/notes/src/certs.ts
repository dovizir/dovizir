/**
 * Cert issuance and chain verification (root -> sarraf -> member).
 * Frozen rules:
 *  - cert signature = issuer sig over keccak256(canonical(cert minus signature));
 *  - expiry boundary: valid iff now < expiry (now == expiry is already expired);
 *  - a signature that does not verify against the cert's OWN `issuer` field
 *    -> BAD_SIGNATURE; broken linkage (issuer is not the presented parent,
 *    wrong role) -> BAD_CERT_CHAIN (referee pin #9);
 *  - cap chaining (review §7): memberCert.capLimit must be <= sarrafCert.capLimit,
 *    else BAD_CERT_CHAIN — a sarraf cannot mint a member cap above its own.
 */
import { isHexBytes, utf8, keccak_256 } from "./bytes.js";
import { canonicalize } from "./canonicalize.js";
import { isCompressedPoint, signDigest, verifyDigest } from "./crypto.js";
import type { Cert, CertRole, Hex, KeyPair, VerifyResult } from "./types.js";
import { normHex } from "./bytes.js";

const bad = (reason: NonNullable<VerifyResult["reason"]>): VerifyResult => ({ valid: false, reason });

export function issueCert(args: {
  issuer: KeyPair;
  subject: Hex;
  role: CertRole;
  sarraf?: Hex;
  capLimit: bigint;
  expiry: number;
}): Cert {
  if (args.role !== "sarraf" && args.role !== "member") throw new Error("issueCert: bad role");
  if (typeof args.capLimit !== "bigint" || args.capLimit < 0n) {
    throw new Error("issueCert: capLimit must be a non-negative bigint");
  }
  if (!Number.isInteger(args.expiry)) throw new Error("issueCert: expiry must be an integer unix time");
  const unsigned: Omit<Cert, "signature"> = {
    subject: normHex(args.subject),
    role: args.role,
    capLimit: args.capLimit,
    expiry: args.expiry,
    issuer: normHex(args.issuer.publicKey),
  };
  if (args.sarraf !== undefined) unsigned.sarraf = normHex(args.sarraf);
  const digest = keccak_256(utf8(canonicalize(unsigned)));
  return { ...unsigned, signature: signDigest(args.issuer.privateKey, digest) };
}

/** Signature check against the cert's own issuer field. */
export function certSignatureValid(cert: Cert): boolean {
  const { signature, ...unsigned } = cert;
  const digest = keccak_256(utf8(canonicalize(unsigned)));
  return verifyDigest(signature, digest, cert.issuer);
}

export function certShapeValid(cert: unknown): cert is Cert {
  if (typeof cert !== "object" || cert === null) return false;
  const c = cert as Partial<Cert>;
  return (
    isCompressedPoint(c.subject) &&
    (c.role === "sarraf" || c.role === "member") &&
    (c.sarraf === undefined || isCompressedPoint(c.sarraf)) &&
    typeof c.capLimit === "bigint" &&
    c.capLimit >= 0n &&
    typeof c.expiry === "number" &&
    Number.isFinite(c.expiry) &&
    isCompressedPoint(c.issuer) &&
    isHexBytes(c.signature, 64)
  );
}

export function verifyCertChain(args: {
  memberCert: Cert;
  sarrafCert: Cert;
  rootPublicKey: Hex;
  now: number;
}): VerifyResult {
  try {
    const { memberCert, sarrafCert, rootPublicKey, now } = args;
    if (
      !certShapeValid(memberCert) ||
      !certShapeValid(sarrafCert) ||
      !isCompressedPoint(rootPublicKey) ||
      typeof now !== "number" ||
      !Number.isFinite(now)
    ) {
      return bad("MALFORMED");
    }
    // 1. Every cert must be signed by its own named issuer.
    if (!certSignatureValid(sarrafCert)) return bad("BAD_SIGNATURE");
    if (!certSignatureValid(memberCert)) return bad("BAD_SIGNATURE");
    // 2. Freshness: valid iff now < expiry (short-lived expiry IS revocation).
    if (now >= sarrafCert.expiry) return bad("EXPIRED_CERT");
    if (now >= memberCert.expiry) return bad("EXPIRED_CERT");
    // 3. Linkage: root -> sarraf-role cert -> member-role cert.
    if (sarrafCert.role !== "sarraf") return bad("BAD_CERT_CHAIN");
    if (memberCert.role !== "member") return bad("BAD_CERT_CHAIN");
    if (sarrafCert.issuer.toLowerCase() !== rootPublicKey.toLowerCase()) return bad("BAD_CERT_CHAIN");
    if (memberCert.issuer.toLowerCase() !== sarrafCert.subject.toLowerCase()) return bad("BAD_CERT_CHAIN");
    if (
      memberCert.sarraf !== undefined &&
      memberCert.sarraf.toLowerCase() !== sarrafCert.subject.toLowerCase()
    ) {
      return bad("BAD_CERT_CHAIN");
    }
    // 4. Cap chaining (review §7): a sarraf cannot grant a member more offline
    //    cap than the root granted the sarraf itself.
    if (memberCert.capLimit > sarrafCert.capLimit) return bad("BAD_CERT_CHAIN");
    return { valid: true };
  } catch {
    return bad("MALFORMED");
  }
}
