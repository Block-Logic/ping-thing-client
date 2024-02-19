// Sample use:
// node ping-thing-client-jupiter.mjs >> ping-thing-jupiter.log 2>&1 &

import dotenv from "dotenv";
import web3, { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import XMLHttpRequest from "xhr2";
import axios from "axios";

// Catch interrupts & exit
process.on("SIGINT", function () {
  console.log(`${new Date().toISOString()} Caught interrupt signal`, "\n");
  process.exit();
});

// Read constants from .env
dotenv.config();
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const USER_KEYPAIR = web3.Keypair.fromSecretKey(
  bs58.decode(process.env.WALLET_PRIVATE_KEYPAIR),
);
const JUPITER_ENDPOINT = `${RPC_ENDPOINT}/jupiter`;

const SLEEP_MS_RPC = process.env.SLEEP_MS_RPC || 2000;
const SLEEP_MS_LOOP = process.env.SLEEP_MS_LOOP || 0;
const VA_API_KEY = process.env.VA_API_KEY;
// process.env.VERBOSE_LOG returns a string. e.g. 'true'
const VERBOSE_LOG = process.env.VERBOSE_LOG === "true" ? true : false;
const COMMITMENT_LEVEL = process.env.COMMITMENT || "confirmed";

const SWAP_TOKEN_FROM = "So11111111111111111111111111111111111111112" // SOL
const SWAP_TOKEN_TO = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" // USDC
const SWAP_AMOUNT = 5000;

if (VERBOSE_LOG) console.log(`${new Date().toISOString()} Starting script`);

// Set up web3 client
const connection = new web3.Connection(RPC_ENDPOINT, {
  commitment: COMMITMENT_LEVEL,
});

const sleep = async (dur) =>
  await new Promise((resolve) => setTimeout(resolve, dur));


const gBlockhash = { value: null, updated_at: 0 };
async function watchBlockhash() {
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
}

// Record new slot on `firstShredReceived`
const gSlotSent = { value: null, updated_at: 0 };
async function watchSlotSent() {
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


async function pingThing() {

  // Pre-define loop constants & variables
  const FAKE_SIGNATURE =
    "9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999";

  // Run inside a loop that will exit after 3 consecutive failures
  const MAX_TRIES = 3;
  let tryCount = 0;

  // Loop until interrupted
  for (let i = 0; ; ++i) {

    // Sleep before the next loop
    if (i > 0) {
      await sleep(SLEEP_MS_LOOP);
    }

    let blockhash;
    let slotSent;
    let slotLanded;
    let signature;
    let txStart;

    let tempResponse;

    let quoteResponse;
    let jupiterSwapTransaction;

    // Wait fresh data
    while (true) {
      if (
        Date.now() - gBlockhash.updated_at < 10000 &&
        Date.now() - gSlotSent.updated_at < 50
      ) {
        blockhash = gBlockhash.value;
        slotSent = gSlotSent.value;
        break;
      }

      await sleep(1);
    }

    try {
      try {

        if (VERBOSE_LOG) console.log(`${new Date().toISOString()} fetching jupiter swap quote`);

        // Get quote for swap
        tempResponse = await axios.get(`${JUPITER_ENDPOINT}/quote?inputMint=${SWAP_TOKEN_FROM}&outputMint=${SWAP_TOKEN_TO}&amount=${SWAP_AMOUNT}&slippageBps=50`);

        // throw error if response is not ok
        if (!(tempResponse.status >= 200) && tempResponse.status < 300) {
          throw new Error(`Failed to fetch jupiter swap quote: ${tempResponse.status}`);
        }

        quoteResponse = tempResponse.data;

        if (VERBOSE_LOG) console.log(`${new Date().toISOString()} fetched jupiter swap quote`);

        if (VERBOSE_LOG) console.log(`${new Date().toISOString()} fetching jupiter swap transaction`);

        // Get swap transaction
        tempResponse = await axios.post(`${JUPITER_ENDPOINT}/swap`, {
          quoteResponse: quoteResponse,
          userPublicKey: USER_KEYPAIR.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        });
        // throw error if response is not ok
        if (!(tempResponse.status >= 200) && tempResponse.status < 300) {
          throw new Error(`Failed to fetch jupiter swap transaction: ${tempResponse.status}`);
        }

        jupiterSwapTransaction = tempResponse.data;

        if (VERBOSE_LOG) console.log(`${new Date().toISOString()} fetched jupiter swap transaction`);

        const swapTransactionBuf = Buffer.from(jupiterSwapTransaction.swapTransaction, 'base64');
        const tx = VersionedTransaction.deserialize(swapTransactionBuf);

        // Sign
        tx.sign([USER_KEYPAIR]);

        if (VERBOSE_LOG) console.log(`${new Date().toISOString()} sending swap transaction`);

        txStart = Date.now();

        // Send and wait confirmation
        signature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
        });

        if (VERBOSE_LOG) console.log(`${new Date().toISOString()} confirming swap transaction ${signature}`);

        const result = await connection.confirmTransaction(
          {
            signature,
            blockhash: blockhash.blockhash,
            lastValidBlockHeight: blockhash.lastValidBlockHeight,
          },
          COMMITMENT_LEVEL,
        );

        if (result.value.err) {
          throw new Error(
            `Transaction ${signature} failed (${JSON.stringify(result.value)})`,
          );
        }

      } catch (e) {
        // Log and loop if we get a bad blockhash.
        if (e.message.includes("Blockhash not found")) {
          console.log(`${new Date().toISOString()} ERROR: Blockhash not found`);
          continue;
        }

        // If the transaction expired on the chain. Make a log entry and send
        // to VA. Otherwise log and loop.
        if (e.name === "TransactionExpiredBlockheightExceededError") {
          console.log(
            `${new Date().toISOString()} ERROR: Blockhash expired/block height exceeded. TX failure sent to VA.`,
          );
        } else {
          console.log(`${new Date().toISOString()} ERROR: ${e.name}`);
          console.log(e.message);
          console.log(e);
          console.log(JSON.stringify(e));
          continue;
        }

        // Need to submit a fake signature to pass the import filters
        signature = FAKE_SIGNATURE;
      }

      const txEnd = Date.now();

      // Sleep a little here to ensure the signature is on an RPC node.
      await sleep(SLEEP_MS_RPC);
      if (signature !== FAKE_SIGNATURE) {
        // Capture the slotLanded
        let txLanded = await connection.getTransaction(signature, {
          commitment: COMMITMENT_LEVEL,
          maxSupportedTransactionVersion: 255,
        });
        if (txLanded === null) {
          console.log(
            signature,
            `${new Date().toISOString()} ERROR: tx is not found on RPC within ${SLEEP_MS_RPC}ms. Not sending to VA.`,
          );
          continue;
        }
        slotLanded = txLanded.slot;
      }

      // Don't send if the slot latency is negative
      if (slotLanded < slotSent) {
        console.log(
          signature,
          `${new Date().toISOString()} ERROR: Slot ${slotLanded} < ${slotSent}. Not sending to VA.`,
        );
        continue;
      }

      // prepare the payload to send to validators.app
      const vAPayload = JSON.stringify({
        time: txEnd - txStart,
        signature,
        transaction_type: "jupiter-swap",
        success: signature !== FAKE_SIGNATURE,
        application: "web3",
        commitment_level: COMMITMENT_LEVEL,
        slot_sent: slotSent,
        slot_landed: slotLanded,
      });

      if (VERBOSE_LOG) {
        console.log(`${new Date().toISOString()} updating validators.app with payload ${vAPayload}`);
      }

      // Send the payload to validators.app
      const vaResponse = await axios.post("https://www.validators.app/api/v1/ping-thing/mainnet", vAPayload, {
        headers: {
          "Content-Type": "application/json",
          "Token": VA_API_KEY
        }
      });
      // throw error if response is not ok
      if (!(vaResponse.status >= 200) && vaResponse.status < 300) {
        throw new Error(`Failed to update validators: ${vaResponse.status}`);
      }

      // Reset the try counter
      tryCount = 0;
    } catch (e) {
      console.log(`${new Date().toISOString()} ERROR: ${e.name}`);
      console.log(`${new Date().toISOString()} ERROR: ${e.message}`);
      if (++tryCount === MAX_TRIES) throw e;
    }
  }
}

await Promise.all([watchBlockhash(), watchSlotSent(), pingThing()]);
