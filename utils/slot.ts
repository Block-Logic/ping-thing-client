// This is a slot watcher. It constantly subscribes to slot changes and updates a global variable

import type { RpcSubscriptions, SlotsUpdatesNotificationsApi } from "@solana/web3.js";
import { sleep } from "./misc.js";

const MAX_SLOT_FETCH_ATTEMPTS = process.env.MAX_SLOT_FETCH_ATTEMPTS ? parseInt(process.env.MAX_SLOT_FETCH_ATTEMPTS) : 100;
let attempts = 0;

// The 2.0 SDK lets us know when a connection is disconnected and we can reconnect
// But we want to wait for some time to give the server some timet to recover and not hammer it with infinite retry requests
// Aggressive reconnects will keep your script stuck in a error loop and consume CPU
const SLOTS_SUBSCRIPTION_DELAY = process.env.SLOTS_SUBSCRIPTION_DELAY ? parseInt(process.env.SLOTS_SUBSCRIPTION_DELAY) : 4000;

export const watchSlotSent = async (gSlotSent: { value: bigint | null, updated_at: number }, rpcSubscription: RpcSubscriptions<SlotsUpdatesNotificationsApi>) => {
  while (true) {
    const abortController = new AbortController();
    try {

      // Subscribing to the `slotsUpdatesSubscribe` and update slot number
      // https://solana.com/docs/rpc/websocket/slotsupdatessubscribe
      const slotNotifications = await rpcSubscription
        .slotsUpdatesNotifications()
        .subscribe({ abortSignal: abortController.signal });

      // handling subscription updates via `AsyncIterators`
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncIterator
      for await (const notification of slotNotifications) {
        if (
          notification.type === "firstShredReceived" ||
          notification.type === "completed"
        ) {
          gSlotSent.value = notification.slot;
          gSlotSent.updated_at = Date.now();
          attempts = 0;
          continue;
        }

        gSlotSent.value = null;
        gSlotSent.updated_at = 0;

        ++attempts;

        // If the RPC is not sending the updates we want, erorr out and crash
        if (attempts >= MAX_SLOT_FETCH_ATTEMPTS) {
          console.log(
            `ERROR: Max attempts for fetching slot type "firstShredReceived" or "completed" reached, exiting`
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
      console.log(`SLOT FETCHER ERROR:`);
      console.log(e);
      ++attempts;

      // Wait before retrying to avoid hammering the RPC and letting it recover
      console.log(`SLOT SUBSCRIPTION TERMINATED ABRUPTLY, SLEEPING FOR ${SLOTS_SUBSCRIPTION_DELAY} BEFORE RETRYING`);

      await sleep(SLOTS_SUBSCRIPTION_DELAY)
    } finally {
      abortController.abort();
    }
  }
};
