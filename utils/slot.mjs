import { sleep } from "./misc.mjs";

export const watchSlotSent = async (gSlotSent,connection) => {
  while (true) {
    const subscriptionId = connection.onSlotUpdate((value) => {
      if (value.type === "firstShredReceived") {
        gSlotSent.value = value.slot;
        gSlotSent.updated_at = Date.now();
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
  }
}