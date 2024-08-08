import { sleep } from "./misc.mjs";

import { createSolanaRpcSubscriptions_UNSTABLE } from "@solana/web3.js";

const MAX_SLOT_FETCH_ATTEMPTS = process.env.MAX_SLOT_FETCH_ATTEMPTS || 5;
let attempts = 0;
const abortController = new AbortController();

export const watchSlotSent = async (gSlotSent, rpcSubscriptions) => {
  try {
    const slotNotifications = await rpcSubscriptions
      .slotsUpdatesNotifications()
      .subscribe({ abortSignal: abortController.signal });

    for await (const notification of slotNotifications) {
      if (notification.type === "firstShredReceived") {
        gSlotSent.value = notification.slot;
        gSlotSent.updated_at = Date.now();
        attempts = 0;
        continue;
      }

      gSlotSent.value = null;
      gSlotSent.updated_at = 0;

      ++attempts;

      if (attempts >= MAX_SLOT_FETCH_ATTEMPTS) {
        console.log(
          `ERROR: Max attempts for fetching slot type "firstShredReceived" reached, exiting`
        );
        process.exit(0);
      }

      // If update not received in last 3s, re-subscribe
      if (gSlotSent.value !== null) {
        while (Date.now() - gSlotSent.updated_at < 3000) {
          await sleep(1);
        }
      }
    }
  } catch (e) {
    console.log(`ERROR: ${e}`);
    ++attempts;
  }
};
