import { sleep } from "./misc.js";
import { safeRace } from "@solana/promises";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type { PrioritizationFeesApi } from "./grpfCustomRpcApi.js";
import { PRIORITY_FEE_PERCENTILE } from "../ping-thing-client.js";


const MAX_PRIORITY_FEE_FETCH_ATTEMPTS = 10;
let attempts = 0;

export type PriorityFees = {
value: number
  updated_at: number;
};

type PrioritizationFeeResult = {
  prioritizationFee: bigint;
  slot: number;
};

export const watchPriorityFees = async (
  gPriorityFees: PriorityFees,
  connection: Rpc<SolanaRpcApi & PrioritizationFeesApi>
) => {
  while (true) {
    try {
      // Use a 5 second timeout to avoid hanging the script
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `${new Date().toISOString()} ERROR: Priority fee fetch operation timed out`
              )
            ),
          5000
        )
      );

      // Get the recent prioritization fees for different percentiles
      const feeResults = (await safeRace([
        connection
          .getRecentPrioritizationFeesTriton([], {
            percentile: PRIORITY_FEE_PERCENTILE,
          })
          .send(),
        timeoutPromise,
      ])) as PrioritizationFeeResult[];

      if (feeResults && feeResults.length > 0) {
        // Convert BigInt fees to numbers for sorting
        const fees: number[] = feeResults.map((result) =>
          Number(result.prioritizationFee)
        );
        const sortedFees = fees.sort((a, b) => a - b);

        // Calculate percentiles
        gPriorityFees.value = sortedFees[sortedFees.length-1];
        gPriorityFees.updated_at = Date.now();
      }

      attempts = 0;
    } catch (error: any) {
gPriorityFees.value = 0;
      gPriorityFees.updated_at = 0;

      ++attempts;

      console.log(
        `${new Date().toISOString()} PRIORITY FEE FETCH ERROR: ${error.name}`
      );
      console.log(error.message);
      console.log(error);
      console.log(JSON.stringify(error));
    } finally {
      if (attempts >= MAX_PRIORITY_FEE_FETCH_ATTEMPTS) {
        console.log(
          `${new Date().toISOString()} ERROR: Max attempts for fetching priority fees reached, exiting`
        );
        process.exit(0);
      }
    }

    await sleep(5000);
  }
};
