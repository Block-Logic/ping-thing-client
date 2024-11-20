import type { Rpc, RpcSubscriptions, SlotNotificationsApi, SlotsUpdatesNotificationsApi, SolanaRpcApi } from "@solana/web3.js";
import { sleep } from "./misc.js";

const MAX_SLOT_FETCH_ATTEMPTS = process.env.MAX_SLOT_FETCH_ATTEMPTS ? parseInt(process.env.MAX_SLOT_FETCH_ATTEMPTS) : 100;
let attempts = 0;

const SLOTS_SUBSCRIPTION_DELAY = process.env.SLOTS_SUBSCRIPTION_DELAY ? parseInt(process.env.SLOTS_SUBSCRIPTION_DELAY) : 4000;

export const watchSlotSent = async (gSlotSent: { value: bigint | null, updated_at: number }, rpcSubscription: RpcSubscriptions<SlotsUpdatesNotificationsApi>) => {
  while (true) {
    const abortController = new AbortController();
    try {
      const slotNotifications = await rpcSubscription
        .slotsUpdatesNotifications()
        .subscribe({ abortSignal: abortController.signal });

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
