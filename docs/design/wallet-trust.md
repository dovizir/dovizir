# Design: Wallet trust boundaries — build verifiability, directory integrity, recovery

Status: DESIGN — documented for future development. **None of this is in the
MVP.** The MVP's job is to state the boundary; these are the mechanisms that
keep it true at scale.

## 0. The boundary being defended

The product promise: *your sarraf can watch your money, stop sponsoring your
gas, and reveal who you are — but they can never take your wallet.*

Why the direct attack already fails (built today):

- The signing key is a WebAuthn P-256 passkey in the device's secure element —
  non-extractable. Ownership changes on the smart account require a signature
  from the current owner; nothing a sarraf holds can produce one.
- The sarraf's roles (paymaster, tranche issuer, KYC attester) carry no key
  powers. A paymaster pays gas; it cannot forge or inject calls. KycRegistry
  cannot even express PII, let alone ownership.
- Passkeys are origin-bound: the credential will not answer on a sarraf's
  domain, so phishing the ceremony onto their own site yields nothing.
- Backing for sold paper sits in the ReservePool; a sarraf cannot redeem paper
  they have sold, and holders can always exit on-chain or migrate at par.

What remains are the three *indirect* vectors this document addresses:

| # | Vector | Who can exploit it | Mechanism class |
|---|---|---|---|
| 1 | The served app code (user signs what the app shows) | Whoever builds/serves the app | Prevent + detect: reproducible builds, provenance, watchdog |
| 2 | Contact resolution (redirect incoming transfers) | The sarraf running the directory answer | Detect + punish: signed bindings, pinning, key transparency |
| 3 | Account recovery (seize ownership "legitimately") | Whoever operates the recovery flow | Prevent: restore ≠ spend, timelocks, vetoes |

## 1. Build verifiability — proving the deployed app is the open-source code

The app is open source precisely so observers can audit it. That is worthless
unless observers can also confirm the *artifact in their hands* came from that
source. Verifiability differs sharply by channel:

### 1.1 Android APK — the reference channel (bit-for-bit verifiable)

The discipline Signal and Telegram already run, adopted wholesale:

1. **Deterministic build recipe, published.** A Dockerfile pinning the entire
   toolchain: Node version, pnpm lockfile, Gradle + Android SDK versions,
   `SOURCE_DATE_EPOCH`, stable file ordering, no embedded timestamps or build
   paths.
2. **CI builds only from signed git tags** and publishes, per release: the APK,
   its SHA-256, and a **provenance attestation** (sigstore/SLSA — an entry in a
   public append-only transparency log proving "this artifact was built from
   this commit by this builder").
3. **Observer procedure** (documented in the repo, runnable by anyone):
   `git checkout <tag>` → run the build container → strip both APKs' signature
   blocks (`META-INF/`) → byte-compare (`diffoscope`). Any diff is an alarm.
4. **Signing-key transparency.** The APK signing-cert fingerprint is pinned in
   the repo and on dovizir.com. Android enforces same-signer on upgrade, so a
   substituted signer cannot silently update existing installs either.

APK-direct-from-dovizir.com is the primary Android channel (no Play Store
dependency), so nothing in the distribution path is outside our control.

### 1.2 iOS / TestFlight — honestly non-verifiable

Apple re-signs and FairPlay-encrypts every distributed binary; byte comparison
is impossible in principle. iOS verifiability reduces to "trust Apple + trust
the publisher." Policy:

- Publish the exact source tag + build environment metadata for every build.
- Treat iOS as a **convenience channel**; the APK is the *reference channel*
  an auditor points to. Never make a security claim for iOS stronger than this.

### 1.3 PWA / web — detection, not prevention

A web server can serve different JavaScript to different visitors, so the web
channel cannot be *prevented* from misbehaving — it can only be **caught**.
Same philosophy as offline notes: detect-and-punish.

- **Independent watchdog** (open source, anyone can run one): continuously
  fetches the served bundles from the production origins, hashes them, and
  compares against the CI-attested artifacts for the deployed tag. Mismatch →
  public alarm. Multiple watchdogs from different network vantage points
  defeat *targeted* serving (the attack where only one victim gets the
  malicious bundle).
- **Release manifest**: every deploy publishes the tag + per-file hashes it is
  serving, so a watchdog compares against a commitment, not a moving target.
- **IPFS mirror** of each frontend release as a verifiable alternative origin
  (content-addressed = self-verifying), useful in the corridor anyway.
- **Steering**: large balances and sarraf desks get an in-app nudge toward the
  verifiable APK. Watch the Isolated Web Apps / signed-web-bundle work as a
  future upgrade path for the web channel itself.

### 1.4 Non-negotiable distribution rule

**Sarrafs never distribute their own builds.** A sarraf-supplied build is the
one attack that turns "sarraf cannot take the wallet" false (the user would
sign an owner change without knowing). Sarraf onboarding materials link to
dovizir.com; nothing else is a supported install source.

## 2. Contact-directory integrity — the Signal model, adapted

The friendly-transfer directory resolves phone/email → wallet. A malicious
resolver could answer with *their own* address and intercept incoming
transfers — theft of incoming money without touching the victim's wallet.
Defense in four layers, cheapest first:

1. **Signed bindings.** A binding ("hash(phone) ↔ address") is signed by the
   *wallet key it points to*, created at enrollment right after OTP
   verification. Changing an existing binding requires a signature from the
   **previous** key (or a completed recovery, §3). A sarraf can therefore
   never rewrite an existing mapping to themselves — they'd need the victim's
   signature. Residual: a sarraf can still fabricate a *first* binding for a
   number they control at enrollment time; layers 2–4 cover that.
2. **Sender-side pinning (TOFU + change alarm).** The sender's app pins the
   first-resolved binding per contact and warns loudly on change — the analog
   of Signal's safety-number-changed banner. Repeat transfers (the common
   case) are then immune to silent substitution.
3. **Self-audit.** Every app periodically resolves *its own* contact details
   and alarms if the directory's answer is not its own address. The victim of
   a substitution finds out even if no sender does.
4. **Key transparency log** (CONIKS / WhatsApp-KT class). All bindings live in
   an append-only Merkle log; the root is anchored on-chain on a fixed cadence.
   Clients verify inclusion proofs for the answers they receive. Serving one
   answer to the sender and another to the auditor (equivocation) produces
   **cryptographic evidence**, which plugs into the existing discipline
   machinery: proof → slashing / de-certification. Privacy: the log stores
   salted hashes of contact details, never the details themselves; private
   contact discovery can come later without changing the log design.

Layers 1–3 are client/indexer work with no new cryptography and are the right
first increment; layer 4 is the endgame that makes directory betrayal
*provable* rather than merely noticeable.

## 3. Recovery safeguards — restore must never equal spend

Recovery is deliberately unbuilt (the passkey module says why: whoever can
restore an account must not be able to spend from it). When it is built, these
are the rails. The failure mode being excluded: a "helpful" sarraf-assisted
recovery that lets a malicious sarraf *legitimately* seize an account.

1. **Platform sync is the first line.** Passkeys sync via the user's platform
   (iCloud Keychain / Google Password Manager), so for most users device loss
   is not key loss and no protocol recovery ever runs. The flows below are the
   fallback, and their friction is acceptable *because* they are the fallback.
2. **Restore ≠ spend.** Recovery never hands over control; it *proposes* a new
   owner key on the smart account via an on-chain recovery module.
3. **Timelock + old-key veto.** The proposal sits in a mandatory delay window
   (days, value-tiered). During the window: every reachable channel (push,
   SMS, email, in-app on all signed-in devices) is notified, and the existing
   passkey — or any existing device/owner — can cancel with one signature. A
   thief racing a live owner always loses.
4. **No unilateral sarraf power.** Sarraf-assisted recovery requires the
   sarraf's attestation **plus** the user's dual-OTP (phone AND email, the
   channels KYC bound at enrollment). Higher balances add a second attester
   (another certified sarraf or the maintainer backstop) — co-signing, same
   spirit as the bond×trust caps: power scales only with independent parties.
5. **Optional guardians.** m-of-n social recovery drawn from the user's
   friendly-transfer graph (mutual contacts), for users who opt in. Guardians
   co-sign the *proposal*; the timelock and veto still apply.
6. **Value-tiered friction.** Small balances: short timelock, sarraf + dual
   OTP. Large balances: long timelock, extra attester, capped spend velocity
   for a period after recovery completes (a drained-in-one-block recovery is
   the tell of a theft, not a restore).
7. **Recovery transparency.** Every proposal, cancellation, and completion is
   an on-chain event. A malicious recovery *attempt* is therefore permanent
   evidence — feeding the same discipline machinery as §2: attempted seizure
   by a sarraf → slash / de-certify, funded by the existing waterfall.
8. **KYC invariants hold.** Recovery cannot bypass KycRegistry attestation
   levels, and completing a recovery never raises a tier — re-attestation is a
   separate, ordinary act by the sponsoring sarraf.

## 4. Sequencing (all post-MVP)

| Increment | Contents | Unlocks |
|---|---|---|
| R1 | Reproducible APK + provenance + observer doc (§1.1) | "Verify it yourself" claim for Android |
| R2 | Release manifest + watchdog (§1.3), signed bindings + pinning + self-audit (§2.1–2.3) | Web channel detection; directory substitution caught |
| R3 | Recovery module: restore-≠-spend, timelock, veto, dual-OTP (§3.2–3.4) | Device-loss story without a seizure path |
| R4 | Key transparency log + on-chain anchoring (§2.4); guardians + value tiers (§3.5–3.6) | Directory betrayal provable; recovery hardened for size |
