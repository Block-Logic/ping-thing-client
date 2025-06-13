// This is a blockhash watcher. It constantly fetches new blockhash and updates a global variable

import type { Blockhash, GetLatestBlockhashApi, Rpc, SolanaRpcApi } from "@solana/kit";
import { sleep } from "./misc.js";
import { safeRace } from "@solana/promises";

const MAX_BLOCKHASH_FETCH_ATTEMPTS = process.env.MAX_BLOCKHASH_FETCH_ATTEMPTS ?
  parseInt(process.env.MAX_BLOCKHASH_FETCH_ATTEMPTS) : 5;
let attempts = 0;

export const watchBlockhash = async (gBlockhash: { value: Blockhash | null, updated_at: number, lastValidBlockHeight: bigint }, connection: Rpc<SolanaRpcApi>) => {

  while (true) {
    try {
      // Use a 5 second timeout to avoid hanging the script
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `${new Date().toISOString()} ERROR: Blockhash fetch operation timed out`
              )
            ),
          5000
        )
      );
      // Get the latest blockhash from the RPC node and update the global
      // blockhash object with the new value and timestamp. If the RPC node
      // fails to respond within 5 seconds, the promise will reject and the
      // script will log an error.
      const latestBlockhash = await safeRace([
        connection.getLatestBlockhash().send(),
        timeoutPromise,
      ]) as ReturnType<GetLatestBlockhashApi['getLatestBlockhash']>;

      gBlockhash.value = latestBlockhash.value.blockhash;
      gBlockhash.lastValidBlockHeight =
        latestBlockhash.value.lastValidBlockHeight;

      gBlockhash.updated_at = Date.now();
      attempts = 0;

    } catch (error: any) {
      gBlockhash.value = null;
      gBlockhash.updated_at = 0;

      ++attempts;

      if (error.message.includes("new blockhash")) {
        console.log(
          `${new Date().toISOString()} ERROR: Unable to obtain a new blockhash`
        );
      } else {
        console.log(`${new Date().toISOString()} BLOCKHASH FETCH ERROR: ${error.name}`);
        console.log(error.message);
        console.log(error);
        console.log(JSON.stringify(error));
      }
    } finally {
      if (attempts >= MAX_BLOCKHASH_FETCH_ATTEMPTS) {
        console.log(
          `${new Date().toISOString()} ERROR: Max attempts for fetching blockhash reached, exiting`
        );
        process.exit(0);
      }
    }

    await sleep(5000);
  }
};
