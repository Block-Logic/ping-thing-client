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
import { watchPriorityFees, type PriorityFees } from "./utils/priorityFees.js";
import { watchBalance } from "./utils/balance.js";
import { setMaxListeners } from "events";
import axios from "axios";
import { safeRace } from "@solana/promises";
import {
  confirmationLatency,
  initPrometheus,
  slotLatency,
} from "./utils/prometheus.js";
import { customizedRpcApi } from "./utils/grpfCustomRpcApi.js";
import { getAddMemoInstruction } from "@solana-program/memo";
import { appendToResultsCsv } from "./utils/csvLogger.js";

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

// if USE_PRIORITY_FEE is set, read and set the fee value, otherwise set it to 0
const PRIORITY_FEE_MICRO_LAMPORTS = USE_PRIORITY_FEE
  ? process.env.PRIORITY_FEE_MICRO_LAMPORTS || 5000
  : 0;
export const PRIORITY_FEE_PERCENTILE = parseInt(
  `${USE_PRIORITY_FEE ? process.env.PRIORITY_FEE_PERCENTILE || 5000 : 0}`
);

const PINGER_REGION = process.env.PINGER_REGION!;

const SKIP_VALIDATORS_APP = process.env.SKIP_VALIDATORS_APP || false;
const SKIP_PROMETHEUS = process.env.SKIP_PROMETHEUS || false;

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

// Global priority fees value fetching constantly in a loop
const gPriorityFees: PriorityFees = {
  value: 0,
  updated_at: 0,
};

// Global balance state
const gBalanceState = {
  isLow: false,
  currentBalance: 0,
  updated_at: 0,
};

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

    let signature;
    let txSendAttempts = 1;
    let priorityFeeMicroLamports = 0;

    // Check if balance is low
    if (gBalanceState.isLow) {
      console.log(
        `${new Date().toISOString()} ERROR: Account balance (${
          gBalanceState.currentBalance
        } SOL) is below minimum threshold. Exiting...`
      );
      process.exit(1);
    }

    // Wait for fresh slot, blockhash and priority fees
    while (true) {
      if (
        gBlockhash.value === null ||
        gBlockhash.value === undefined ||
        gSlotSent.value === null ||
        gSlotSent.value === undefined ||
        gPriorityFees.updated_at === 0
      ) {
        await sleep(1);
        continue;
      }
      break;
    }

    try {
      try {
        if (USE_PRIORITY_FEE) {
          priorityFeeMicroLamports = gPriorityFees.value;
        }

        console.log(`Fees ${priorityFeeMicroLamports}`);

        const slotSent = gSlotSent.value;
        const sequenceNumber = Date.now();

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
                  units: 10200,
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

                getAddMemoInstruction({
                  memo: `${slotSent},${sequenceNumber}`,
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

        // Log the results to CSV
        appendToResultsCsv(slotSent, sequenceNumber, signature);

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

        try {
          mSendTransaction(transactionSignedWithFeePayer, {
            maxRetries: 0n,
            skipPreflight: true,
            commitment: "confirmed",
            abortSignal: abortController.signal,
          });
        } catch (e: any) {
          if (e.message === "TxSendTimeout") {
            console.log(
              `Tx not confirmed after ${
                TX_RETRY_INTERVAL * txSendAttempts++
              }ms, resending`
            );
            continue;
          } else if (isSolanaError(e, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) {
            throw new Error("TransactionExpiredBlockheightExceededError");
          } else {
            throw e;
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
      // Reset the try counter
      tryCount = 0;
    } catch (e) {
      console.log(`ERROR`);
      console.log(e);
      if (++tryCount === MAX_TRIES) throw e;
    }
  }
}

  Promise.all([
    // @ts-ignore
    watchBlockhash(gBlockhash, rpcConnection),
    watchSlotSent(gSlotSent, rpcSubscriptions),
    // @ts-ignore
    watchPriorityFees(gPriorityFees, rpcConnection),
    // @ts-ignore
    watchBalance(rpcConnection, gBalanceState),
    initPrometheus(),
    pingThing(),
  ]);

