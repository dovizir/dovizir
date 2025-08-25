import Fastify from "fastify";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { addresses, reservePoolAbi } from "@dovizir/sdk";

const RPC = process.env.BASE_SEPOLIA_RPC_URL!;
const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const app = Fastify();
app.get("/health", async () => ({ ok: true }));

app.get("/member/:addr", async (req: any) => {
  const member = req.params.addr as `0x${string}`;
  const reserve = await client.readContract({
    address: addresses.baseSepolia.reservePool as `0x${string}`,
    abi: reservePoolAbi,
    functionName: "reserveBalance",
    args: [member],
  });
  return { member, reserve: reserve.toString() };
});

app.listen({ port: 4000, host: "0.0.0.0" }).then(() => {
  console.log("Indexer API on :4000");
});
