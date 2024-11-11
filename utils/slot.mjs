import { sleep } from "./misc.mjs";

const MAX_SLOT_FETCH_ATTEMPTS = process.env.MAX_SLOT_FETCH_ATTEMPTS || 100;
let attempts = 0;

export const watchSlotSent = async (gSlotSent, rpcSubscriptions) => {
  while (true) {
    const abortController = new AbortController();
    try {
      const slotNotifications = await rpcSubscriptions
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
      console.log(`ERROR:`);
      console.log(e);
      ++attempts;
    } finally {
      abortController.abort();
    }
  }
};
