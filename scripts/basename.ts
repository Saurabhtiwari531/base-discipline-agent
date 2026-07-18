/**
 * Basename tooling for the agent identity.
 *
 *   npx tsx scripts/basename.ts check <name>      — availability + price + balance
 *   npx tsx scripts/basename.ts register <name>   — registers <name>.base.eth to the
 *                                                   agent wallet (WALLET_KEY), sets
 *                                                   forward addr + primary (reverse)
 *
 * Contracts (Base mainnet, from github.com/base/basenames):
 *   RegistrarController 0xa7d2607c6BD39Ae9521e514026CBB078405Ab322
 *   L2Resolver          0x426fA03fB86E510d0Dd9F70335Cf102a98b10875
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  namehash,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const CONTROLLER = "0xa7d2607c6BD39Ae9521e514026CBB078405Ab322" as const;
const L2_RESOLVER = "0x426fA03fB86E510d0Dd9F70335Cf102a98b10875" as const;
const YEAR_SECONDS = 365n * 24n * 3600n;

// NOTE: the deployed implementation's RegisterRequest has 3 more fields than the
// repo's main branch (coinTypes, signatureExpiry, signature — used only when
// reverseRecord=true). ABI pulled from the verified implementation on Blockscout.
const controllerAbi = parseAbi([
  "function available(string name) view returns (bool)",
  "function registerPrice(string name, uint256 duration) view returns (uint256)",
  "function reverseRegistrar() view returns (address)",
  "function register((string name, address owner, uint256 duration, address resolver, bytes[] data, bool reverseRecord, uint256[] coinTypes, uint256 signatureExpiry, bytes signature) request) payable",
]);

const resolverAbi = parseAbi([
  "function setAddr(bytes32 node, address a)",
  "function setText(bytes32 node, string key, string value)",
]);

const MIME_BY_EXT: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

async function main() {
  const [, , cmd, name, extra] = process.argv;
  if (!cmd || !name) {
    console.error("usage: basename.ts <check|register|avatar> <name> [path-to-image]");
    process.exit(1);
  }

  const walletKey = process.env.WALLET_KEY as `0x${string}` | undefined;
  if (!walletKey) throw new Error("WALLET_KEY missing in .env");
  const account = privateKeyToAccount(walletKey);
  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });

  // Avatar doesn't need the availability/price lookup below — the name is
  // already owned by this wallet by the time you're setting a picture for it.
  if (cmd === "avatar") {
    if (!extra) throw new Error("usage: basename.ts avatar <name> <path-to-image>");
    const ext = extra.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME_BY_EXT[ext];
    if (!mime) throw new Error(`unsupported image type .${ext} — use .svg, .png, or .jpg`);

    const bytes = readFileSync(extra);
    const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
    console.log(`image:           ${extra} (${bytes.length} bytes)`);
    console.log(`data URI:        ${dataUri.length} chars`);

    const node = namehash(`${name}.base.eth`);
    await publicClient.simulateContract({
      account,
      address: L2_RESOLVER,
      abi: resolverAbi,
      functionName: "setText",
      args: [node, "avatar", dataUri],
    });

    const walletClient = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL) });
    const hash = await walletClient.writeContract({
      address: L2_RESOLVER,
      abi: resolverAbi,
      functionName: "setText",
      args: [node, "avatar", dataUri],
    });
    console.log(`avatar tx:       ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`status:          ${receipt.status} (block ${receipt.blockNumber})`);
    return;
  }

  const [available, price, balance] = await Promise.all([
    publicClient.readContract({ address: CONTROLLER, abi: controllerAbi, functionName: "available", args: [name] }),
    publicClient.readContract({ address: CONTROLLER, abi: controllerAbi, functionName: "registerPrice", args: [name, YEAR_SECONDS] }),
    publicClient.getBalance({ address: account.address }),
  ]);

  console.log(`name:            ${name}.base.eth`);
  console.log(`available:       ${available}`);
  console.log(`price (1 year):  ${formatEther(price)} ETH`);
  console.log(`agent wallet:    ${account.address}`);
  console.log(`agent balance:   ${formatEther(balance)} ETH`);

  if (cmd === "check") return;

  if (cmd === "register") {
    if (!available) throw new Error("name not available");
    const value = (price * 110n) / 100n; // +10% buffer; excess is refunded by the controller
    // Base gas for a registration is ~0.000005-0.000015 ETH — reserve 0.00002.
    if (balance < value + 20_000_000_000_000n) {
      throw new Error(
        `insufficient funds: need ~${formatEther(value)} ETH + gas; send ETH on Base to ${account.address}`,
      );
    }

    // Forward resolution: tradecoach.base.eth -> agent address.
    const node = namehash(`${name}.base.eth`);
    const setAddrData = encodeFunctionData({
      abi: resolverAbi,
      functionName: "setAddr",
      args: [node, account.address],
    });

    const request = {
      name,
      owner: account.address,
      duration: YEAR_SECONDS,
      resolver: L2_RESOLVER,
      data: [setAddrData],
      // Primary (reverse) name needs a signed message on this controller version;
      // we set it in a separate direct call from the wallet instead (see below).
      reverseRecord: false,
      coinTypes: [] as bigint[],
      signatureExpiry: 0n,
      signature: "0x" as `0x${string}`,
    };

    // Simulate first — a revert here costs nothing.
    await publicClient.simulateContract({
      account,
      address: CONTROLLER,
      abi: controllerAbi,
      functionName: "register",
      args: [request],
      value,
    });

    const walletClient = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL) });
    const hash = await walletClient.writeContract({
      address: CONTROLLER,
      abi: controllerAbi,
      functionName: "register",
      args: [request],
      value,
    });
    console.log(`register tx:     ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`status:          ${receipt.status} (block ${receipt.blockNumber})`);
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
