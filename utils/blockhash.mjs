import { sleep } from "./misc.mjs";

export const watchBlockhash = async (gBlockhash, connection) => {
  // const gBlockhash = { value: null, updated_at: 0 };
  while (true) {
    try {
      // Use a 5 second timeout to avoid hanging the script
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Operation timed out')), 5000)
      );
      // Get the latest blockhash from the RPC node and update the global
      // blockhash object with the new value and timestamp. If the RPC node
      // fails to respond within 5 seconds, the promise will reject and the
      // script will log an error.
      gBlockhash.value = await Promise.race([
        connection.getLatestBlockhash("finalized"),
        timeoutPromise
      ]);

      gBlockhash.updated_at = Date.now();
    } catch (error) {
      gBlockhash.value = null;
      gBlockhash.updated_at = 0;

      if (error.message.includes("new blockhash")) {
        console.log(
          `${new Date().toISOString()} ERROR: Unable to obtain a new blockhash`,
        );
      } else {
        console.log(`${new Date().toISOString()} ERROR: ${error.name}`);
        console.log(error.message);
        console.log(error);
        console.log(JSON.stringify(error));
      }
    }

    await sleep(5000);
  }
};