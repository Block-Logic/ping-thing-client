import {
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
  createSolanaRpcSubscriptions_UNSTABLE,
  getSignatureFromTransaction,
  compileTransaction,
  createSolanaRpc,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  isSolanaError,
  type Signature,
  type Commitment,
  sendAndConfirmTransactionFactory,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  createRpc,
  createDefaultRpcTransport,
  type Transaction,
  getTransactionEncoder,
} from "@solana/kit";
import dotenv from "dotenv";
import bs58 from "bs58";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import { sleep } from "./utils/misc.js";
import { watchBlockhash } from "./utils/blockhash.js";
import { watchSlotSent } from "./utils/slot.js";
import { setMaxListeners } from "events";
import axios from "axios";
import { safeRace } from "@solana/promises";
import {
  confirmationLatency,
  initPrometheus,
  slotLatency,
} from "./utils/prometheus.js";
import { customizedRpcApi } from "./utils/grpfCustomRpcApi.js";
import { createRecentSignatureConfirmationPromiseFactory } from "@solana/transaction-confirmation";

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

const SLEEP_MS_RPC = process.env.SLEEP_MS_RPC
  ? parseInt(process.env.SLEEP_MS_RPC)
  : 2000;
const SLEEP_MS_LOOP = process.env.SLEEP_MS_LOOP
  ? parseInt(process.env.SLEEP_MS_LOOP)
  : 0;
const VA_API_KEY = process.env.VA_API_KEY;
const VERBOSE_LOG = process.env.VERBOSE_LOG === "true" ? true : false;
const COMMITMENT_LEVEL = process.env.COMMITMENT || "confirmed";
const USE_PRIORITY_FEE = process.env.USE_PRIORITY_FEE == "true" ? true : false;
const CUSTOM_SEND_TX_ENDPOINT = process.env.CUSTOM_SEND_TX_ENDPOINT
  ? process.env.CUSTOM_SEND_TX_ENDPOINT
  : RPC_ENDPOINT;

// if USE_PRIORITY_FEE is set, read and set the fee value, otherwise set it to 0
const PRIORITY_FEE_MICRO_LAMPORTS = USE_PRIORITY_FEE
  ? process.env.PRIORITY_FEE_MICRO_LAMPORTS || 5000
  : 0;
const PRIORITY_FEE_PERCENTILE = parseInt(
  `${USE_PRIORITY_FEE ? process.env.PRIORITY_FEE_PERCENTILE || 5000 : 0}`
);

const PINGER_REGION = process.env.PINGER_REGION!;

const SKIP_VALIDATORS_APP =
  process.env.SKIP_VALIDATORS_APP === "true" ? true : false;
const SKIP_PROMETHEUS = process.env.SKIP_PROMETHEUS === "true" ? true : false;

const PINGER_NAME = process.env.PINGER_NAME || "UNSET";

if (VERBOSE_LOG) console.log(`Starting script`);

// RPC connection for HTTP API calls, equivalent to `const c = new Connection(RPC_ENDPOINT)`
// const rpcConnection = createSolanaRpc(RPC_ENDPOINT!);
const rpcConnection = createRpc({
  api: customizedRpcApi,
  transport: createDefaultRpcTransport({ url: RPC_ENDPOINT! }),
});

// RPC connection for websocket connection
const rpcSubscriptions = createSolanaRpcSubscriptions_UNSTABLE(WS_ENDPOINT!);

let USER_KEYPAIR;
const TX_RETRY_INTERVAL = 2000;

// Global blockhash value fetching constantly in a loop
const gBlockhash = {
  value: null,
  updated_at: 0,
  lastValidBlockHeight: BigInt(0),
};

// Record new slot on `firstShredReceived` fetched from a slot subscription
const gSlotSent = { value: null, updated_at: 0 };

// main ping thing function
async function pingThing() {
  USER_KEYPAIR = await createKeyPairFromBytes(
    bs58.decode(process.env.WALLET_PRIVATE_KEYPAIR!)
  );
  // Pre-define loop constants & variables
  const FAKE_SIGNATURE =
    "9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999";

  // Run inside a loop that will exit after 3 consecutive failures
  const MAX_TRIES = 3;
  let tryCount = 0;

  const feePayer = await getAddressFromPublicKey(USER_KEYPAIR.publicKey);
  const signer = await createSignerFromKeyPair(USER_KEYPAIR);

  // Infinite loop to keep this running forever
  while (true) {
    await sleep(SLEEP_MS_LOOP);

    let blockhash;
    let lastValidBlockHeight;
    let slotSent;
    let slotLanded;
    let signature;
    let txStart;
    let txSendAttempts = 1;
    let priorityFeeMicroLamports = 0;

    // Wait for fresh slot and blockhash
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
        if (USE_PRIORITY_FEE) {
          const feeResults = await rpcConnection
            .getRecentPrioritizationFeesTriton([], {
              percentile: PRIORITY_FEE_PERCENTILE,
            })
            .send();

          if (feeResults && feeResults.length > 0) {
            const fees: number[] = [];
            for (let i = 0; i < feeResults.length; i++) {
              fees.push(feeResults[i].prioritizationFee);
            }

            const sortedFeesArray = fees.sort();

            priorityFeeMicroLamports =
              sortedFeesArray[sortedFeesArray.length - 1];
          }
        }

        console.log(`Fees ${priorityFeeMicroLamports}`);

        // Pipe multiple instructions in a tx
        // Names are self-explainatory. See the imports of these functions
        const transaction = pipe(
          createTransactionMessage({ version: 0 }),
          (tx) => setTransactionMessageFeePayer(feePayer, tx),
          (tx) =>
            setTransactionMessageLifetimeUsingBlockhash(
              {
                blockhash: gBlockhash.value!,
                lastValidBlockHeight: BigInt(gBlockhash.lastValidBlockHeight!),
              },
              tx
            ),
          (tx) =>
            appendTransactionMessageInstructions(
              [
                getSetComputeUnitLimitInstruction({
                  units: 500,
                }),
                getSetComputeUnitPriceInstruction({
                  microLamports: BigInt(priorityFeeMicroLamports),
                }),

                // SOL transfer instruction
                getTransferSolInstruction({
                  // @ts-ignore
                  source: signer,
                  // @ts-ignore
                  destination: feePayer,
                  amount: 5000,
                }),
              ],
              tx
            )
        );

        // Sign the tx
        const transactionSignedWithFeePayer = await signTransaction(
          [USER_KEYPAIR],
          compileTransaction(transaction)
        );

        // Get the tx signature
        signature = getSignatureFromTransaction(transactionSignedWithFeePayer);

        // Note the timestamp we begin sending the tx, we'll compare it with the
        // timestamp when the tx is confirmed to mesaure the tx latency
        txStart = Date.now();

        console.log(`Sending ${signature}`);

        // The tx sendinng and confirming startegy of the Ping Thing is as follow:
        // 1. Send the tranaction
        // 2. Subscribe to the tx signature and listen for dersied commitment change
        // 3. Send the tx again if not confrmed within 2000ms
        // 4. Stop sending when tx is confirmed

        // Create a sender factory that sends a transaction and doesn't wait for confirmation
        const mSendTransaction = sendTransactionWithoutConfirmingFactory({
          rpc: rpcConnection,
        });

        // Incase we want to abort the promise that's waiting for a tx to be confirmed
        const abortController = new AbortController();

        const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
          rpc: rpcConnection,
          rpcSubscriptions,
        });

        const getRecentSignatureConfirmationPromise =
          //@ts-ignore
          createRecentSignatureConfirmationPromiseFactory({
            rpc: rpcConnection,
            rpcSubscriptions,
          });

        const wireTransactionBytes = getTransactionEncoder().encode(
          transactionSignedWithFeePayer
        );
        const txString = bs58.encode(wireTransactionBytes as Uint8Array);

        while (true) {
          try {
            await sendTransactionToCustomEndpoint(txString);

            await safeRace([
              // sendAndConfirmTransaction(transactionSignedWithFeePayer, {
              //   maxRetries: 0n,
              //   skipPreflight: true,
              //   commitment: "confirmed",
              //   abortSignal: abortController.signal,
              // }),
              getRecentSignatureConfirmationPromise({
                abortSignal: abortController.signal,
                commitment: "confirmed",
                // @ts-ignore
                signature: signature,
              }),
              sleep(TX_RETRY_INTERVAL).then(() => {
                throw new Error("TxSendTimeout");
              }),
            ]);

            console.log(`Confirmed tx ${signature}`);

            break;
          } catch (e: any) {
            if (e.message === "TxSendTimeout") {
              console.log(
                `Tx not confirmed after ${
                  TX_RETRY_INTERVAL * txSendAttempts++
                }ms, resending`
              );
              await sendTransactionToCustomEndpoint(txString);
              continue;
            } else if (isSolanaError(e, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) {
              throw new Error("TransactionExpiredBlockheightExceededError");
            } else {
              throw e;
            }
          }
        }
      } catch (e: any) {
        // Log and loop if we get a bad blockhash.
        if (
          isSolanaError(e, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)
        ) {
          // if (e.message.includes("Blockhash not found")) {
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
        signature = FAKE_SIGNATURE as Signature;
      }

      const txEnd = Date.now();
      // Sleep a little here to ensure the signature is on an RPC node.
      await sleep(SLEEP_MS_RPC);
      if (signature !== FAKE_SIGNATURE) {
        // Capture the slotLanded
        let txLanded = await rpcConnection
          .getTransaction(signature, {
            commitment: COMMITMENT_LEVEL as Commitment,
            maxSupportedTransactionVersion: 0,
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
      if (slotLanded! < slotSent!) {
        console.log(
          signature,
          `ERROR: Slot ${slotLanded} < ${slotSent}. Not sending to VA.`
        );
        continue;
      }

      // prepare the payload to send to validators.app
      const vAPayload = JSON.stringify({
        time: txEnd - txStart!,
        signature,
        transaction_type: "transfer",
        success: signature !== FAKE_SIGNATURE,
        application: "web3",
        commitment_level: COMMITMENT_LEVEL,
        slot_sent: BigInt(slotSent!).toString(),
        slot_landed: BigInt(slotLanded!).toString(),
        priority_fee_percentile: Math.floor(PRIORITY_FEE_PERCENTILE / 100),
        priority_fee_micro_lamports: `${priorityFeeMicroLamports}`,
        pinger_region: PINGER_REGION,
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
            `VA Response ${vaResponse.status} ${JSON.stringify(
              vaResponse.data
            )}`
          );
        }
      } else {
        console.log(
          `SKIP_VALIDATORS_APP set to ${SKIP_VALIDATORS_APP}, not sending to VA`
        );
      }

      if (!SKIP_PROMETHEUS) {
        confirmationLatency.observe(
          {
            pinger_name: PINGER_NAME,
          },
          txEnd - txStart!
        );

        slotLatency.observe(
          {
            pinger_name: PINGER_NAME,
          },
          Number(slotLanded! - slotSent!)
        );
      }

      // Reset the try counter
      tryCount = 0;
    } catch (e) {
      console.log(`ERROR`);
      console.log(e);
      if (++tryCount === MAX_TRIES) throw e;
    }
  }
}

async function sendTransactionToCustomEndpoint(transactionString: String) {
  const res = await fetch(CUSTOM_SEND_TX_ENDPOINT!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        transactionString,
        {
          maxRetries: 0,
          skipPreflight: true,
          commitment: "confirmed",
        },
      ],
    }),
  });

  const json = await res.json();

  console.log("Custom sendTransaction endpoint response:");
  console.log(json);

  return json.result;
}

Promise.all([
  watchBlockhash(gBlockhash, rpcConnection),
  watchSlotSent(gSlotSent, rpcSubscriptions),
  initPrometheus(),
  pingThing(),
]);
