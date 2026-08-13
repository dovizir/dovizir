/**
 * offline-notes-e2e.mjs — end-to-end proof of the M4 offline-notes flow against
 * a live anvil (chain 84532). Run AFTER `anvil --chain-id 84532` +
 * script/Deploy.s.sol have produced deployments/84532.json.
 *
 *   node apps/web/scripts/offline-notes-e2e.mjs
 *
 * What it proves, with hard assertions and captured logs:
 *   1. OFFLINE (pure @dovizir/notes, zero chain): carve a batch, create an
 *      invoice, spend a note into a Transcript, and verify it offline through
 *      the frozen cert chain + recipient binding + signature.
 *   2. ON-CHAIN SETTLEMENT: the SAME note's serial carved on-chain, then a real
 *      reconcile lands — recipient IOU minted, serial marked spent. The
 *      transcript/proof/signature are re-encoded into the frozen TranscriptLib
 *      on-chain format (the contract header pins that the on-chain encoding is
 *      its own; the TS wire format may differ — they share the serial, carver
 *      key, amount and expiry, which is the bridge).
 *   3. DOUBLE-SPEND CONVICTION: the same serial spent to a second seller with a
 *      different invoice → DoubleSpendConvicted fires. The victim is made whole
 *      from the cheater's SEIZED collateral first, then an INSURANCE-FUND USDT
 *      top-up covers the shortfall.
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodePacked,
  http,
  keccak256,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount, sign, signatureToHex } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  carveBatch,
  createInvoice,
  generateKeyPair,
  hashInvoice,
  issueCert,
  spendNote,
  verifyTranscript,
} from "@dovizir/notes";
// ABIs from the forge artifacts (the SDK entry is TS-only, unloadable by node).
const outDir = resolve(fileURLToPath(import.meta.url), "../../../../packages/contracts/out");
const abiOf = (name) => JSON.parse(readFileSync(`${outDir}/${name}.sol/${name}.json`, "utf8")).abi;
const iouTokenAbi = abiOf("IouToken");
const insuranceFundAbi = abiOf("InsuranceFund");
const memberRegistryAbi = abiOf("MemberRegistry");
const mockUsdtAbi = abiOf("MockUsdt");
const noteVaultAbi = abiOf("NoteVault");
const reservePoolAbi = abiOf("ReservePool");
const sarrafRegistryAbi = abiOf("SarrafRegistry");

// ------------------------------------------------------------------- helpers
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const here = dirname(fileURLToPath(import.meta.url));
const deployments = JSON.parse(
  readFileSync(resolve(here, "../../../packages/contracts/deployments/84532.json"), "utf8"),
);
const A = {
  iou: deployments.iouToken,
  memberRegistry: deployments.memberRegistry,
  reservePool: deployments.reservePool,
  insuranceFund: deployments.insuranceFund,
  sarrafRegistry: deployments.sarrafRegistry,
  noteVault: deployments.noteVault,
  usdt: deployments.usdt,
};

// anvil deterministic keys
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  sarraf: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  carver: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // the cheater
  seller1: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  seller2: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  redeemer: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};

const acct = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]));
const chain = { id: 84532, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wallet = (a) => createWalletClient({ account: a, chain, transport: http(RPC) });

let fails = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const bad = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); fails++; };
const eq = (label, got, want) => (String(got) === String(want) ? ok(`${label} (${got})`) : bad(`${label} expected=${want} got=${got}`));
const usd = (v) => (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 });

async function send(account, address, abi, functionName, args = []) {
  const hash = await wallet(account).writeContract({ address, abi, functionName, args });
  return pub.waitForTransactionReceipt({ hash });
}
async function read(address, abi, functionName, args = []) {
  return pub.readContract({ address, abi, functionName, args });
}

// ------- the bridge: TS offline artifacts -> frozen on-chain TranscriptLib ----
const INVOICE_TYPEHASH = keccak256(
  new TextEncoder().encode("DovizirInvoice(address recipient,uint256 amount,bytes32 nonce)"),
);
// keccak256(abi.encode(TYPEHASH, recipient, amount, nonce))
const onchainInvoiceHash = (recipient, amount, nonce) =>
  keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address, uint256, bytes32"), [
      INVOICE_TYPEHASH,
      recipient,
      amount,
      nonce,
    ]),
  );
// keccak256(abi.encodePacked(serial, invoiceHash, uint64 expiry, batchRoot))
const onchainSpendDigest = (serial, invHash, expiry, batchRoot) =>
  keccak256(
    encodePacked(["bytes32", "bytes32", "uint64", "bytes32"], [serial, invHash, BigInt(expiry), batchRoot]),
  );
// abi.encode(recipient, amount, nonce)
const onchainTranscript = (recipient, amount, nonce) =>
  encodeAbiParameters(parseAbiParameters("address, uint256, bytes32"), [recipient, amount, nonce]);

// Solidity-side merkle: leaf = keccak256(serial); interior = sorted-pair keccak.
const solLeaf = (serial) => keccak256(encodePacked(["bytes32"], [serial]));
const solPair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b])) : keccak256(encodePacked(["bytes32", "bytes32"], [b, a])));
function solRootAndProof(serials, index) {
  let level = serials.map(solLeaf);
  const proof = [];
  let idx = index;
  while (level.length > 1) {
    const sibling = idx ^ 1;
    if (sibling < level.length) proof.push(level[sibling]);
    const next = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(solPair(level[i], level[i + 1]));
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    level = next;
    idx >>= 1;
  }
  return { root: level[0], proof };
}
// raw-digest 65-byte {r,s,v} signature by the carver's key
async function carverSig65(privateKey, digest) {
  return signatureToHex(await sign({ hash: digest, privateKey, to: "object" }));
}

// ============================================================================
async function main() {
  console.log(`\n== Dovizir M4 offline-notes E2E @ chain ${await pub.getChainId()} via ${RPC} ==\n`);

  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 30 * 24 * 3600;
  const TID = BigInt(acct.sarraf.address); // trancheId = uint256(uint160(sarraf))

  // ---- (a) certify the sarraf, onboard members, issue IOU ------------------
  console.log("-- (a) certify sarraf, onboard carver + redeemer, issue IOU --------------");
  const DEPOSIT = 3_000_000_000000n;
  await send(acct.sarraf, A.usdt, mockUsdtAbi, "mint", [acct.sarraf.address, DEPOSIT]);
  await send(acct.sarraf, A.usdt, mockUsdtAbi, "approve", [A.reservePool, DEPOSIT]);
  await send(acct.sarraf, A.reservePool, reservePoolAbi, "deposit", [DEPOSIT]);
  await test.increaseTime({ seconds: 604801 });
  await test.mine({ blocks: 1 });
  await send(acct.sarraf, A.sarrafRegistry, sarrafRegistryAbi, "evaluate", []);
  eq("sarraf certified", await read(A.sarrafRegistry, sarrafRegistryAbi, "isCertified", [acct.sarraf.address]), true);

  await send(acct.sarraf, A.memberRegistry, memberRegistryAbi, "addMember", [acct.carver.address]);
  await send(acct.sarraf, A.memberRegistry, memberRegistryAbi, "addMember", [acct.redeemer.address]);
  await send(acct.sarraf, A.reservePool, reservePoolAbi, "issue", [acct.carver.address, 20_000_000000n]);
  await send(acct.sarraf, A.reservePool, reservePoolAbi, "issue", [acct.redeemer.address, 1_200_000_000000n]);

  // ---- (b) bank insurance reserves via a redemption (90bps fee) ------------
  console.log("-- (b) redeemer redeems 1,120,000 IOU -> 90bps fee funds the insurance pool");
  const REDEEM = 1_120_000_000000n;
  await send(acct.redeemer, A.reservePool, reservePoolAbi, "redeem", [acct.sarraf.address, REDEEM]);
  const fundReserves0 = await read(A.insuranceFund, insuranceFundAbi, "totalReserves", []);
  eq("insurance reserves banked", fundReserves0, (REDEEM * 90n) / 10000n);
  console.log(`  info  insurance reserves = ${usd(fundReserves0)} USDT`);

  // ---- OFFLINE WORLD (pure @dovizir/notes, no chain) -----------------------
  console.log("\n-- (c) OFFLINE: carve a batch, spend a note, verify it offline (no network)");
  // Offline identities are secp256k1 keys (frozen lib); on-chain identities are
  // the anvil addresses. They share the serial, amount and expiry — the bridge.
  const root = generateKeyPair("0x01");
  const carverK = generateKeyPair("0x02");
  const seller1K = generateKeyPair("0x03");
  const seller2K = generateKeyPair("0x04");
  const sarrafK = generateKeyPair("0x05");
  const CAP = 100_000_000000n;
  const sarrafCert = issueCert({ issuer: root, subject: sarrafK.publicKey, role: "sarraf", capLimit: CAP, expiry });
  const memberCert = issueCert({ issuer: sarrafK, subject: carverK.publicKey, role: "member", sarraf: sarrafK.publicKey, capLimit: CAP, expiry });

  const batchSalt = "0x" + "ab".repeat(32);
  const batch = carveBatch({ carver: carverK, trancheId: `0x${TID.toString(16)}`, denominations: [10_000_000000n, 5_000_000000n], expiry, batchSalt });
  const noteIndex = 0; // the 10,000 note we will double-spend
  const serial = batch.notes[noteIndex].serial;
  console.log(`  info  batch of ${batch.notes.length} notes, root ${batch.batchRoot.slice(0, 18)}…`);
  console.log(`  info  double-spend target serial ${serial.slice(0, 18)}…`);

  const invoice1 = createInvoice({ recipient: seller1K, amount: 10_000_000000n, nonce: "0x" + "11".repeat(32), createdAt: now, memo: "coffee" });
  const transcript1 = spendNote({ batch, noteIndex, invoice: invoice1, carver: carverK });
  const v1 = verifyTranscript({ transcript: transcript1, memberCert, sarrafCert, rootPublicKey: root.publicKey, now, expectedRecipient: seller1K.publicKey });
  eq("offline verifyTranscript(seller1) valid", v1.valid, true);
  // negative control: wrong recipient
  const vWrong = verifyTranscript({ transcript: transcript1, memberCert, sarrafCert, rootPublicKey: root.publicKey, now, expectedRecipient: seller2K.publicKey });
  eq("offline verify rejects wrong recipient", vWrong.reason, "RECIPIENT_MISMATCH");
  eq("invoiceHash binds the invoice", hashInvoice(invoice1), transcript1.invoiceHash);

  // ---- ON-CHAIN: carve the same serial-batch, approve, lock IOU ------------
  console.log("\n-- (d) ON-CHAIN: carve the batch (locks carver IOU in the sarraf tranche)");
  const serials = batch.notes.map((n) => n.serial);
  const { root: onchainRoot, proof: proof0 } = solRootAndProof(serials, noteIndex);
  await send(acct.carver, A.iou, iouTokenAbi, "setApprovalForAll", [A.noteVault, true]);
  const CARVE_TOTAL = 15_000_000000n;
  const carveRcpt = await send(acct.carver, A.noteVault, noteVaultAbi, "carve", [onchainRoot, CARVE_TOTAL, BigInt(expiry)]);
  eq("Carved event", carveRcpt.logs.length > 0, true);
  eq("lockedOf(carver)", await read(A.noteVault, noteVaultAbi, "lockedOf", [acct.carver.address]), CARVE_TOTAL);
  console.log(`  info  on-chain batchRoot ${onchainRoot.slice(0, 18)}… locked ${usd(CARVE_TOTAL)} IOU`);

  // ---- (e) REAL RECONCILE: settle the offline spend on-chain ---------------
  console.log("\n-- (e) RECONCILE seller1 on-chain (the honest first-spend settles)");
  const nonce1 = "0x" + "11".repeat(32);
  const amt = 10_000_000000n;
  const inv1Hash = onchainInvoiceHash(acct.seller1.address, amt, nonce1);
  const digest1 = onchainSpendDigest(serial, inv1Hash, expiry, onchainRoot);
  const sig1 = await carverSig65(KEYS.carver, digest1);
  const tx1 = onchainTranscript(acct.seller1.address, amt, nonce1);
  const rec1 = await send(acct.seller1, A.noteVault, noteVaultAbi, "reconcile", [onchainRoot, serial, proof0, tx1, sig1]);
  const reconciledLog = rec1.logs.find((l) => l.topics[0] === keccak256(new TextEncoder().encode("NoteReconciled(bytes32,address,uint256)")));
  eq("NoteReconciled emitted", !!reconciledLog, true);
  eq("seller1 IOU minted", await read(A.iou, iouTokenAbi, "balanceOf", [acct.seller1.address, TID]), amt);
  eq("serial isSpent", await read(A.noteVault, noteVaultAbi, "isSpent", [serial]), true);
  eq("lockedOf(carver) after reconcile", await read(A.noteVault, noteVaultAbi, "lockedOf", [acct.carver.address]), CARVE_TOTAL - amt);
  console.log(`  info  \x1b[36mA TS-derived transcript reconciled on-chain — seller1 paid ${usd(amt)} IOU\x1b[0m`);

  // ---- (f) DOUBLE-SPEND: same serial, second seller -> CONVICTION ----------
  console.log("\n-- (f) DOUBLE-SPEND the same serial to seller2 -> DoubleSpendConvicted");
  const seller2Usdt0 = await read(A.usdt, mockUsdtAbi, "balanceOf", [acct.seller2.address]);
  const nonce2 = "0x" + "22".repeat(32);
  const inv2Hash = onchainInvoiceHash(acct.seller2.address, amt, nonce2);
  const digest2 = onchainSpendDigest(serial, inv2Hash, expiry, onchainRoot);
  const sig2 = await carverSig65(KEYS.carver, digest2);
  const tx2 = onchainTranscript(acct.seller2.address, amt, nonce2);
  const rec2 = await send(acct.seller2, A.noteVault, noteVaultAbi, "reconcile", [onchainRoot, serial, proof0, tx2, sig2]);
  const convictLog = rec2.logs.find((l) => l.topics[0] === keccak256(new TextEncoder().encode("DoubleSpendConvicted(bytes32,address,address)")));
  eq("DoubleSpendConvicted emitted", !!convictLog, true);
  eq("serial convicted flag", await read(A.noteVault, noteVaultAbi, "convicted", [serial]), true);

  const seizedComp = CARVE_TOTAL - amt; // 5,000 locked remained -> seized to victim
  const shortfall = amt - seizedComp; // 5,000 topped up from insurance
  eq("seller2 compensated in SEIZED carver IOU", await read(A.iou, iouTokenAbi, "balanceOf", [acct.seller2.address, TID]), seizedComp);
  const seller2Usdt1 = await read(A.usdt, mockUsdtAbi, "balanceOf", [acct.seller2.address]);
  eq("seller2 INSURANCE USDT top-up", seller2Usdt1 - seller2Usdt0, shortfall);
  eq("insurance reserves drawn by shortfall", fundReserves0 - (await read(A.insuranceFund, insuranceFundAbi, "totalReserves", [])), shortfall);
  eq("carver locked value fully seized", await read(A.noteVault, noteVaultAbi, "lockedOf", [acct.carver.address]), 0n);

  // decode the conviction event topics
  const convictedCarver = `0x${convictLog.topics[2].slice(26)}`;
  const convictedVictim = `0x${convictLog.topics[3].slice(26)}`;
  eq("convicted carver == cheater", convictedCarver.toLowerCase(), acct.carver.address.toLowerCase());
  eq("compensated victim == seller2", convictedVictim.toLowerCase(), acct.seller2.address.toLowerCase());

  // ---- proof summary -------------------------------------------------------
  console.log("\n== CONVICTION PROOF ====================================================");
  console.log(`  cheating carver     ${acct.carver.address}`);
  console.log(`  double-spent serial ${serial}`);
  console.log(`  honest victim       ${acct.seller2.address} (seller2)`);
  console.log(`  made whole for      ${usd(amt)} IOU-equivalent, from:`);
  console.log(`    - seized collateral ${usd(seizedComp)} (cheater's own locked IOU)`);
  console.log(`    - insurance fund    ${usd(shortfall)} USDT top-up`);
  console.log(`  insurance reserves  ${usd(fundReserves0)} -> ${usd(await read(A.insuranceFund, insuranceFundAbi, "totalReserves", []))} USDT`);
  console.log("========================================================================\n");

  if (fails === 0) console.log("== ALL ASSERTIONS PASSED ==\n");
  else { console.log(`== ${fails} ASSERTION(S) FAILED ==\n`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
