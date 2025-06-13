import { sleep } from "./misc.js";
import { safeRace } from "@solana/promises";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type { Address } from "@solana/kit";
import { createKeyPairFromBytes, getAddressFromPublicKey } from "@solana/kit";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

const MIN_BALANCE_SOL = 0.01;
const BALANCE_CHECK_INTERVAL = 5000; // 5 seconds

export type BalanceState = {
  isLow: boolean;
  currentBalance: number;
  updated_at: number;
};

export const watchBalance = async (
  connection: Rpc<SolanaRpcApi>,
  balanceState: BalanceState
) => {
  // Create keypair from private key
  const USER_KEYPAIR = await createKeyPairFromBytes(
    bs58.decode(process.env.WALLET_PRIVATE_KEYPAIR!)
  );
  const address = await getAddressFromPublicKey(USER_KEYPAIR.publicKey);

  while (true) {
    try {
      // Use a 5 second timeout to avoid hanging the script
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `${new Date().toISOString()} ERROR: Balance fetch operation timed out`
              )
            ),
          5000
        )
      );

      // Get the account balance
      const balanceResponse = (await safeRace([
        connection.getBalance(address).send(),
        timeoutPromise,
      ])) as { value: bigint };

      // Convert lamports to SOL (1 SOL = 1e9 lamports)
      const balanceInSol = Number(balanceResponse.value) / 1e9;

      // Update the shared state
      balanceState.isLow = balanceInSol < MIN_BALANCE_SOL;
      balanceState.currentBalance = balanceInSol;
      balanceState.updated_at = Date.now();

      if (balanceState.isLow) {
        console.log(
          `${new Date().toISOString()} WARNING: Account balance (${balanceInSol} SOL) is below minimum threshold (${MIN_BALANCE_SOL} SOL)`
        );
      } else {
        console.log(
          `${new Date().toISOString()} Current balance: ${balanceInSol} SOL`
        );
      }
    } catch (error: any) {
      console.log(
        `${new Date().toISOString()} BALANCE FETCH ERROR: ${error.name}`
      );
      console.log(error.message);
      console.log(error);
      console.log(JSON.stringify(error));
    }

    await sleep(BALANCE_CHECK_INTERVAL);
  }
};
