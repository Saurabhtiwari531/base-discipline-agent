import "dotenv/config";
import { createPublicClient, createWalletClient, http, namehash, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const REVERSE_REGISTRAR = "0x79EA96012eEa67A83431F1701B3dFf7e37F9E282" as const;
const L2_RESOLVER = "0x426fA03fB86E510d0Dd9F70335Cf102a98b10875" as const;
const FULL_NAME = "tradecoach.base.eth";

async function main() {
  const account = privateKeyToAccount(process.env.WALLET_KEY as `0x${string}`);
  const pc = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
  const wc = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL) });

  // Forward resolution check: tradecoach.base.eth -> agent address
  const resolved = await pc.readContract({
    address: L2_RESOLVER,
    abi: parseAbi(["function addr(bytes32 node) view returns (address)"]),
    functionName: "addr",
    args: [namehash(FULL_NAME)],
  });
  console.log("forward addr():", resolved, resolved.toLowerCase() === account.address.toLowerCase() ? "✓" : "✗ MISMATCH");

  // Primary (reverse) name: agent wallet claims its own name
  const abi = parseAbi(["function setName(string name)"]);
  await pc.simulateContract({ account, address: REVERSE_REGISTRAR, abi, functionName: "setName", args: [FULL_NAME] });
  const hash = await wc.writeContract({ address: REVERSE_REGISTRAR, abi, functionName: "setName", args: [FULL_NAME] });
  console.log("setName tx:", hash);
  const rc = await pc.waitForTransactionReceipt({ hash });
  console.log("status:", rc.status, "(block", rc.blockNumber + ")");
}
main();
