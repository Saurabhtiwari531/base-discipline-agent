/**
 * One-off key generator for the agent's XMTP identity.
 *
 *   npm run gen:keys
 *
 * Copy the printed values into your .env (NEVER commit them). WALLET_KEY is the
 * agent's wallet private key; ENCRYPTION_KEY encrypts the local XMTP database.
 */
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

function main() {
  const walletKey = generatePrivateKey(); // 0x-prefixed 32-byte private key
  const account = privateKeyToAccount(walletKey);
  const encryptionKey = `0x${randomBytes(32).toString("hex")}`;

  // eslint-disable-next-line no-console
  console.log(
    [
      "# Add these to your .env (keep them secret, never commit):",
      `WALLET_KEY=${walletKey}`,
      `ENCRYPTION_KEY=${encryptionKey}`,
      "",
      `# Agent public address (share this so users can DM it): ${account.address}`,
    ].join("\n"),
  );
}

main();
