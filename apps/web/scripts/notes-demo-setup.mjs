/**
 * notes-demo-setup.mjs — prepare a fresh anvil for the browser offline-notes
 * demo (apps/web /notes/demo). Idempotent-ish: certifies the sarraf, onboards
 * the carver persona, issues it IOU, and banks insurance reserves via a
 * redemption so the double-spend conviction can pay a victim.
 *
 *   anvil --chain-id 84532
 *   forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil-0>
 *   node apps/web/scripts/notes-demo-setup.mjs
 */
import { createPublicClient, createTestClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const here = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(resolve(here, "../../../packages/contracts/deployments/84532.json"), "utf8"));
const outDir = resolve(here, "../../../packages/contracts/out");
const abiOf = (n) => JSON.parse(readFileSync(`${outDir}/${n}.sol/${n}.json`, "utf8")).abi;
const usdtAbi = abiOf("MockUsdt"), poolAbi = abiOf("ReservePool"), sarregAbi = abiOf("SarrafRegistry"), memregAbi = abiOf("MemberRegistry"), fundAbi = abiOf("InsuranceFund");

const KEYS = {
  sarraf: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  carver: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  redeemer: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};
const acct = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]));
const chain = { id: 84532, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wallet = (a) => createWalletClient({ account: a, chain, transport: http(RPC) });
const send = async (a, address, abi, functionName, args = []) => pub.waitForTransactionReceipt({ hash: await wallet(a).writeContract({ address, abi, functionName, args }) });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const usd = (v) => (Number(v) / 1e6).toLocaleString("en-US");

async function main() {
  console.log(`== preparing anvil for the offline-notes demo @ ${RPC} ==`);

  if (!(await read(dep.sarrafRegistry, sarregAbi, "isCertified", [acct.sarraf.address]))) {
    const DEPOSIT = 3_000_000_000000n;
    await send(acct.sarraf, dep.usdt, usdtAbi, "mint", [acct.sarraf.address, DEPOSIT]);
    await send(acct.sarraf, dep.usdt, usdtAbi, "approve", [dep.reservePool, DEPOSIT]);
    await send(acct.sarraf, dep.reservePool, poolAbi, "deposit", [DEPOSIT]);
    await test.increaseTime({ seconds: 604801 });
    await test.mine({ blocks: 1 });
    await send(acct.sarraf, dep.sarrafRegistry, sarregAbi, "evaluate", []);
    console.log("  certified sarraf");
  } else console.log("  sarraf already certified");

  for (const [name, a] of [["carver", acct.carver], ["redeemer", acct.redeemer]]) {
    if (!(await read(dep.memberRegistry, memregAbi, "isMember", [a.address]))) {
      await send(acct.sarraf, dep.memberRegistry, memregAbi, "addMember", [a.address]);
      console.log(`  onboarded ${name} ${a.address}`);
    }
  }

  const carverIou = await read(dep.iouToken, abiOf("IouToken"), "balanceOf", [acct.carver.address, BigInt(acct.sarraf.address)]);
  if (carverIou < 50_000_000000n) {
    await send(acct.sarraf, dep.reservePool, poolAbi, "issue", [acct.carver.address, 80_000_000000n]);
    console.log("  issued 80,000 IOU to carver");
  }

  let reserves = await read(dep.insuranceFund, fundAbi, "totalReserves", []);
  if (reserves < 10_000_000000n) {
    await send(acct.sarraf, dep.reservePool, poolAbi, "issue", [acct.redeemer.address, 1_200_000_000000n]);
    await send(acct.redeemer, dep.reservePool, poolAbi, "redeem", [acct.sarraf.address, 1_120_000_000000n]);
    reserves = await read(dep.insuranceFund, fundAbi, "totalReserves", []);
    console.log("  funded insurance via redemption");
  }

  console.log(`== ready ==`);
  console.log(`  carver      ${acct.carver.address}  IOU ${usd(await read(dep.iouToken, abiOf("IouToken"), "balanceOf", [acct.carver.address, BigInt(acct.sarraf.address)]))}`);
  console.log(`  insurance   ${usd(reserves)} USDT reserves`);
}
main().catch((e) => { console.error(e); process.exit(1); });
