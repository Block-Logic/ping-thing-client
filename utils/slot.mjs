import { sleep } from "./misc.mjs";

const MAX_SLOT_FETCH_ATTEMPTS = process.env.MAX_SLOT_FETCH_ATTEMPTS || 5;
let attempts = 0;

export const watchSlotSent = async (gSlotSent, connection) => {
  while (true) {
    try {
      const subscriptionId = connection.onSlotUpdate((value) => {
        if (value.type === "firstShredReceived") {
          gSlotSent.value = value.slot;
          gSlotSent.updated_at = Date.now();
          attempts = 0;
        }
      });

      // do not re-subscribe before first update, max 60s
      const started_at = Date.now();
      while (gSlotSent.value === null && Date.now() - started_at < 60000) {
        await sleep(1);
      }

      // If update not received in last 3s, re-subscribe
      if (gSlotSent.value !== null) {
        while (Date.now() - gSlotSent.updated_at < 3000) {
          await sleep(1);
        }
      }

      await connection.removeSlotUpdateListener(subscriptionId);
      gSlotSent.value = null;
      gSlotSent.updated_at = 0;

      ++attempts;

      if (attempts >= MAX_SLOT_FETCH_ATTEMPTS) {
        console.log(
          `${new Date().toISOString()} ERROR: Max attempts for fetching slot type "firstShredReceived" reached, exiting`
        );
        process.exit(0);
      }
    } catch (e) {
      console.log(`${new Date().toISOString()} ERROR: ${e}`);
      ++attempts;
    }
  }
};
