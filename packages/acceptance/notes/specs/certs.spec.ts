/**
 * Area 7 — issueCert / verifyCertChain.
 * Pinned rules:
 *   Cert signature = issuer secp256k1 sig over
 *     keccak256(utf8(canonical(cert minus the signature field))).
 *   Expiry boundary: a cert is valid iff now < expiry
 *     (now == expiry - 1 -> valid; now == expiry -> EXPIRED_CERT).
 *   A cert whose signature does not verify against its issuer -> BAD_SIGNATURE;
 *   a structurally broken link (wrong issuer/role) -> BAD_CERT_CHAIN.
 */
import { describe, expect, it } from "vitest";
import { canonicalize, issueCert, verifyCertChain, type Cert } from "@dovizir/notes";
import {
  clone,
  flipLastByte,
  keccak_256,
  refCanonical,
  sigValid,
  utf8,
} from "./support/helpers";
import {
  CARVER,
  CERT_EXPIRY,
  MEMBER_CAP,
  ROOT,
  SARRAF,
  SARRAF_CAP,
  T0,
  makeCerts,
} from "./support/fixtures";

function unsigned(cert: Cert): Omit<Cert, "signature"> {
  const { signature: _sig, ...rest } = cert;
  return rest;
}

describe("issueCert", () => {
  const { sarrafCert, memberCert } = makeCerts();

  it("carries subject, role, sponsoring sarraf, capLimit, expiry, and issuer", () => {
    expect(memberCert.subject.toLowerCase()).toBe(CARVER.publicKey);
    expect(memberCert.role).toBe("member");
    expect(memberCert.sarraf?.toLowerCase()).toBe(SARRAF.publicKey);
    expect(memberCert.capLimit).toBe(MEMBER_CAP);
    expect(memberCert.expiry).toBe(CERT_EXPIRY);
    expect(memberCert.issuer.toLowerCase()).toBe(SARRAF.publicKey);
  });

  it("sarraf certs name the root as issuer and carry their own cap", () => {
    expect(sarrafCert.subject.toLowerCase()).toBe(SARRAF.publicKey);
    expect(sarrafCert.role).toBe("sarraf");
    expect(sarrafCert.capLimit).toBe(SARRAF_CAP);
    expect(sarrafCert.issuer.toLowerCase()).toBe(ROOT.publicKey);
  });

  it("signs keccak256 of the canonical serialization of the cert minus its signature", () => {
    for (const [cert, issuerPub] of [
      [memberCert, SARRAF.publicKey],
      [sarrafCert, ROOT.publicKey],
    ] as const) {
      const digest = keccak_256(utf8(canonicalize(unsigned(cert))));
      expect(sigValid(cert.signature, digest, issuerPub)).toBe(true);
    }
  });

  it("canonical cert preimage matches the referee's reading of the wire rules", () => {
    expect(canonicalize(unsigned(memberCert))).toBe(refCanonical(unsigned(memberCert)));
  });
});

describe("verifyCertChain", () => {
  const { sarrafCert, memberCert } = makeCerts();
  const chain = (over: Partial<Parameters<typeof verifyCertChain>[0]> = {}) =>
    verifyCertChain({
      memberCert,
      sarrafCert,
      rootPublicKey: ROOT.publicKey,
      now: T0,
      ...over,
    });

  it("accepts a valid root -> sarraf -> member chain", () => {
    const res = chain();
    expect(res.valid).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it("member cert is valid at now == expiry - 1", () => {
    expect(chain({ now: CERT_EXPIRY - 1 }).valid).toBe(true);
  });

  it("member cert is invalid at now == expiry: valid iff now < expiry", () => {
    // PINNED boundary — short-lived expiry IS the revocation mechanism, so
    // the instant of expiry is already out.
    const res = chain({ now: CERT_EXPIRY });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("EXPIRED_CERT");
  });

  it("member cert is invalid at now == expiry + 1", () => {
    const res = chain({ now: CERT_EXPIRY + 1 });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("EXPIRED_CERT");
  });

  it("sarraf cert expiry is enforced independently of the member cert", () => {
    const shortSarraf = issueCert({
      issuer: ROOT,
      subject: SARRAF.publicKey,
      role: "sarraf",
      capLimit: SARRAF_CAP,
      expiry: T0, // expires exactly now -> invalid under now < expiry
    });
    const res = chain({ sarrafCert: shortSarraf });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("EXPIRED_CERT");
  });

  it("a tampered cert signature yields BAD_SIGNATURE", () => {
    const forged = clone(memberCert);
    forged.signature = flipLastByte(forged.signature);
    const res = chain({ memberCert: forged });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_SIGNATURE");
  });

  it("a tampered capLimit breaks the cert signature (capLimit is signed)", () => {
    const inflated = clone(memberCert);
    inflated.capLimit = inflated.capLimit * 100n;
    const res = chain({ memberCert: inflated });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_SIGNATURE");
  });

  it("rejects a member cert whose issuer is not the presented sarraf (BAD_CERT_CHAIN)", () => {
    const otherSarraf = issueCert({
      issuer: ROOT,
      subject: CARVER.publicKey, // a different subject holding sarraf role
      role: "sarraf",
      capLimit: SARRAF_CAP,
      expiry: CERT_EXPIRY,
    });
    // memberCert.issuer == SARRAF, but the chain presents CARVER's sarraf cert.
    const res = chain({ sarrafCert: otherSarraf });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("BAD_CERT_CHAIN");
  });
});
