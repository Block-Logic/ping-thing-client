import {
  createSolanaRpcFromTransport,
  createDefaultRpcTransport,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  createKeyPairFromBytes,
  getAddressFromPublicKey,
  createSignerFromKeyPair,
  signTransaction,
  appendTransactionMessageInstructions,
  sendTransactionWithoutConfirmingFactory,
  createSolanaRpcSubscriptions,
  createSolanaRpcSubscriptions_UNSTABLE,
  getSignatureFromTransaction,
  compileTransaction,
  // Address,
} from "@solana/web3.js";
import dotenv from "dotenv";
import bs58 from "bs58";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import { createRecentSignatureConfirmationPromiseFactory } from "@solana/transaction-confirmation";
import { sleep } from "./utils/misc.mjs";
import { watchBlockhash } from "./utils/blockhash.mjs";
import { watchSlotSent } from "./utils/slot.mjs";
import { setMaxListeners } from "events";
import axios from "axios";

dotenv.config();

const orignalConsoleLog = console.log;
console.log = function (...message) {
  const dateTime = new Date().toUTCString();
  orignalConsoleLog(dateTime, ...message);
};

// Catch interrupts & exit
process.on("SIGINT", function () {
  console.log(`Caught interrupt signal`, "\n");
  process.exit();
});


const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const WS_ENDPOINT = process.env.WS_ENDPOINT;

const SLEEP_MS_RPC = process.env.SLEEP_MS_RPC || 2000;
const SLEEP_MS_LOOP = process.env.SLEEP_MS_LOOP || 0;
const VA_API_KEY = process.env.VA_API_KEY;
const VERBOSE_LOG = process.env.VERBOSE_LOG === "true" ? true : false;
const COMMITMENT_LEVEL = process.env.COMMITMENT || "confirmed";
const USE_PRIORITY_FEE = process.env.USE_PRIORITY_FEE == "true" ? true : false;
const SKIP_VALIDATORS_APP = process.env.SKIP_VALIDATORS_APP || false;

if (VERBOSE_LOG) console.log(`Starting script`);

const transport = createDefaultRpcTransport({
  url: RPC_ENDPOINT,
});

const connection = createSolanaRpcFromTransport(transport);

const rpcSubscriptions = createSolanaRpcSubscriptions_UNSTABLE(
  WS_ENDPOINT
);

let USER_KEYPAIR;
const TX_RETRY_INTERVAL = 2000;

const gBlockhash = { value: null, updated_at: 0, lastValidBlockHeight: 0 };

// Record new slot on `firstShredReceived`
const gSlotSent = { value: null, updated_at: 0 };
async function pingThing() {
  USER_KEYPAIR = await createKeyPairFromBytes(
    bs58.decode(process.env.WALLET_PRIVATE_KEYPAIR)
  );
  // Pre-define loop constants & variables
  const FAKE_SIGNATURE =
    "9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999";

  // Run inside a loop that will exit after 3 consecutive failures
  const MAX_TRIES = 3;
  let tryCount = 0;

  const feePayer = await getAddressFromPublicKey(USER_KEYPAIR.publicKey);
  const signer = await createSignerFromKeyPair(USER_KEYPAIR);

  while (true) {
    await sleep(SLEEP_MS_LOOP);

    let blockhash;
    let lastValidBlockHeight;
    let slotSent;
    let slotLanded;
    let signature;
    let txStart;
    let txSendAttempts = 0;

    // Wait fresh data
    while (true) {
      if (
        Date.now() - gBlockhash.updated_at < 10000 &&
        Date.now() - gSlotSent.updated_at < 50
      ) {
        blockhash = gBlockhash.value;
        lastValidBlockHeight = gBlockhash.lastValidBlockHeight;
        slotSent = gSlotSent.value;
        break;
      }

      await sleep(1);
    }

    try {
      try {
        // const latestBlockhash = await connection.getLatestBlockhash().send();
        const transaction = pipe(
          createTransactionMessage({ version: 0 }),
          (tx) => setTransactionMessageFeePayer(feePayer, tx),
          (tx) =>
            setTransactionMessageLifetimeUsingBlockhash(
              {
                blockhash: gBlockhash.value,
                lastValidBlockHeight: gBlockhash.lastValidBlockHeight,
              },
              tx
            ),
          (tx) =>
            appendTransactionMessageInstructions(
              [
                getSetComputeUnitLimitInstruction({
                  units: 500,
                }),
                getTransferSolInstruction({
                  source: signer,
                  destination: feePayer,
                  amount: 5000,
                }),
              ],
              tx
            )
        );
        const transactionSignedWithFeePayer = await signTransaction(
          [USER_KEYPAIR],
          compileTransaction(transaction)
        );
        signature = getSignatureFromTransaction(transactionSignedWithFeePayer);

        txStart = Date.now();

        console.log(`Sending ${signature}`);

        const mSendTransaction = sendTransactionWithoutConfirmingFactory({
          rpc: connection,
        });

        const getRecentSignatureConfirmationPromise =
          createRecentSignatureConfirmationPromiseFactory({
            rpc: connection,
            rpcSubscriptions,
          });
        setMaxListeners(100);
        const abortController = new AbortController();

        while (true) {
          try {
            await mSendTransaction(transactionSignedWithFeePayer, {
              commitment: "confirmed",
              maxRetries: 0n,
            });

            await Promise.race([
              getRecentSignatureConfirmationPromise({
                signature,
                commitment: "confirmed",
                abortSignal: abortController.signal,
              }),
              sleep(TX_RETRY_INTERVAL * txSendAttempts).then(() => {
                throw new Error("Tx Send Timeout");
              }),
            ]);

            console.log(`Confirmed tx ${signature}`);

            break;
          } catch (e) {
            console.log(e);
            console.log(
              `Tx not confirmed after ${
                TX_RETRY_INTERVAL * txSendAttempts++
              }ms, resending`
            );
          }
        }
      } catch (e) {
        // Log and loop if we get a bad blockhash.
        if (e.message.includes("Blockhash not found")) {
          console.log(`ERROR: Blockhash not found`);
          continue;
        }

        // If the transaction expired on the chain. Make a log entry and send
        // to VA. Otherwise log and loop.
        if (e.name === "TransactionExpiredBlockheightExceededError") {
          console.log(
            `ERROR: Blockhash expired/block height exceeded. TX failure sent to VA.`
          );
        } else {
          console.log(`ERROR: ${e.name}`);
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
        let txLanded = await connection
          .getTransaction(signature, {
            commitment: COMMITMENT_LEVEL,
            maxSupportedTransactionVersion: 255,
          })
          .send();
        if (txLanded === null) {
          console.log(
            signature,
            `ERROR: tx is not found on RPC within ${SLEEP_MS_RPC}ms. Not sending to VA.`
          );
          continue;
        }
        slotLanded = txLanded.slot;
      }

      // Don't send if the slot latency is negative
      if (slotLanded < slotSent) {
        console.log(
          signature,
          `ERROR: Slot ${slotLanded} < ${slotSent}. Not sending to VA.`
        );
        continue;
      }

      // prepare the payload to send to validators.app
      const vAPayload = JSON.stringify({
        time: txEnd - txStart,
        signature,
        transaction_type: "transfer",
        success: signature !== FAKE_SIGNATURE,
        application: "web3",
        commitment_level: COMMITMENT_LEVEL,
        slot_sent: BigInt(slotSent).toString(),
        slot_landed: BigInt(slotLanded).toString(),
      });
      if (VERBOSE_LOG) {
        console.log(vAPayload);
      }

      if (!SKIP_VALIDATORS_APP) {
        // Send the payload to validators.app
        const vaResponse = await axios.post(
          "https://www.validators.app/api/v1/ping-thing/mainnet",
          vAPayload,
          {
            headers: {
              "Content-Type": "application/json",
              Token: VA_API_KEY,
            },
          }
        );
        // throw error if response is not ok
        if (!(vaResponse.status >= 200 && vaResponse.status <= 299)) {
          throw new Error(`Failed to update validators: ${vaResponse.status}`);
        }

        if (VERBOSE_LOG) {
          console.log(
            `VA Response ${
              vaResponse.status
            } ${JSON.stringify(vaResponse.data)}`
          );
        }
      }

      // Reset the try counter
      tryCount = 0;
    } catch (e) {
      console.log(`ERROR: ${e}`);
      if (++tryCount === MAX_TRIES) throw e;
    }
  }
}

await Promise.all([
  watchBlockhash(gBlockhash, connection),
  watchSlotSent(gSlotSent, rpcSubscriptions),
  pingThing(),
]);
