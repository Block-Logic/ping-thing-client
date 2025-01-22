import {
  setTransactionMessageLifetimeUsingBlockhash,
  createKeyPairFromBytes,
  getAddressFromPublicKey,
  signTransaction,
  sendTransactionWithoutConfirmingFactory,
  createSolanaRpcSubscriptions_UNSTABLE,
  getSignatureFromTransaction,
  compileTransaction,
  createSolanaRpc,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  isSolanaError,
  type Signature,
  type Commitment,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessageFetchingLookupTables,
  sendAndConfirmTransactionFactory,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
} from "@solana/web3.js";
import dotenv from "dotenv";
import bs58 from "bs58";
import { createRecentSignatureConfirmationPromiseFactory } from "@solana/transaction-confirmation";
import { sleep } from "./utils/misc.js";
import { watchBlockhash } from "./utils/blockhash.js";
import { watchSlotSent } from "./utils/slot.js";
import { setMaxListeners } from "events";
import axios from "axios";
import { safeRace } from "@solana/promises";

dotenv.config();

// Catch interrupts & exit
process.on("SIGINT", function () {
  console.log(`Caught interrupt signal`, "\n");
  process.exit();
});

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const WS_ENDPOINT = process.env.WS_ENDPOINT;

const SLEEP_MS_RPC = process.env.SLEEP_MS_RPC ? parseInt(process.env.SLEEP_MS_RPC) : 2000;
const SLEEP_MS_LOOP = process.env.SLEEP_MS_LOOP ? parseInt(process.env.SLEEP_MS_LOOP) : 0;
const VA_API_KEY = process.env.VA_API_KEY;
const VERBOSE_LOG = process.env.VERBOSE_LOG === "true" ? true : false;
const COMMITMENT_LEVEL = process.env.COMMITMENT || "confirmed";

const SKIP_VALIDATORS_APP = process.env.SKIP_VALIDATORS_APP || false;

const SWAP_TOKEN_FROM = "So11111111111111111111111111111111111111112"; // SOL
const SWAP_TOKEN_TO = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const SWAP_AMOUNT = 1000;

const JUPITER_ENDPOINT = `${RPC_ENDPOINT}/jupiter`;
const PRIORITY_FEE_PERCENTILE = process.env.PRIORITY_FEE_PERCENTILE || 5000;

if (VERBOSE_LOG) console.log(`Starting script`);

// RPC connection for HTTP API calls, equivalent to `const c = new Connection(RPC_ENDPOINT)`
const rpcConnection = createSolanaRpc(RPC_ENDPOINT!);

// RPC connection for websocket connection
const rpcSubscriptions = createSolanaRpcSubscriptions_UNSTABLE(WS_ENDPOINT!);

let USER_KEYPAIR;
const TX_RETRY_INTERVAL = 2000;

// Global blockhash value fetching constantly in a loop
const gBlockhash = { value: null, updated_at: 0, lastValidBlockHeight: BigInt(0) };

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

    let tempResponse;

    let quoteResponse;
    let jupiterSwapTransaction;

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
        if (VERBOSE_LOG)
          console.log(
            `fetching jupiter swap quote`
          );

        // Get quote for swap
        tempResponse = await axios.get(
          `${JUPITER_ENDPOINT}/quote?inputMint=${SWAP_TOKEN_FROM}&outputMint=${SWAP_TOKEN_TO}&amount=${SWAP_AMOUNT}&slippageBps=50`
        );

        // Throw error if response is not ok
        if (!(tempResponse.status >= 200) && tempResponse.status < 300) {
          throw new Error(
            `Failed to fetch jupiter swap quote: ${tempResponse.status}`
          );
        }

        quoteResponse = tempResponse.data;

        if (VERBOSE_LOG)
          console.log(`fetched jupiter swap quote`);

        // get priority fees from teh improved priority fees api
        // https://docs.triton.one/chains/solana/improved-priority-fees-api
        const priorityFeeApiResult = await axios.post(`${RPC_ENDPOINT}`, {
          method: "getRecentPrioritizationFees",
          jsonrpc: "2.0",
          params: [
            ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
            {
              percentile: parseInt(PRIORITY_FEE_PERCENTILE.toString()),
            },
          ],
          id: "1",
        });

        // get the fees array from the response array
        const fees: number[] = priorityFeeApiResult.data.result.map((i: { slot: number, prioritizationFee: number }) => i.prioritizationFee);

        const medianFees = fees.sort()[Math.floor(fees.length / 2)]

        if (VERBOSE_LOG)
          console.log(`fetched global priority fees for jupiter`);

        const userPublicKey = await getAddressFromPublicKey(USER_KEYPAIR.publicKey);

        // Get swap transaction
        tempResponse = await axios.post(`${JUPITER_ENDPOINT}/swap`, {
          quoteResponse: quoteResponse,
          userPublicKey: userPublicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: medianFees,
        });
        // throw error if response is not ok
        if (!(tempResponse.status >= 200) && tempResponse.status < 300) {
          throw new Error(
            `failed to fetch jupiter swap transaction: ${tempResponse.status}`
          );
        }

        if (VERBOSE_LOG)
          console.log(
            `fetched jupiter swap transaction`
          );

        jupiterSwapTransaction = tempResponse.data;

        const swapTransactionBuffer = Buffer.from(
          jupiterSwapTransaction.swapTransaction,
          "base64"
        );

        // ---- Start: Decode and parse the transaction ----
        const transactionDecoder = getTransactionDecoder()
        const decodedTx = transactionDecoder.decode(swapTransactionBuffer)

        const compiledTransactionMessageDecoder = getCompiledTransactionMessageDecoder()
        const compiledTransactionMessage = compiledTransactionMessageDecoder.decode(decodedTx.messageBytes)

        const txMessage = await decompileTransactionMessageFetchingLookupTables(compiledTransactionMessage, rpcConnection)

        // Set blockhash
        const finalTxWithBlockhash = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash!, lastValidBlockHeight: lastValidBlockHeight }, txMessage)

        // Sign the tx
        const transactionSignedWithFeePayer = await signTransaction(
          [USER_KEYPAIR],
          compileTransaction(finalTxWithBlockhash)
        );

        signature = getSignatureFromTransaction(transactionSignedWithFeePayer);

        // ---- End: Decode and parse the transaction ----

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

        // Create a promise factory that has the logic for a the tx to be confirmed
        const getRecentSignatureConfirmationPromise =
          createRecentSignatureConfirmationPromiseFactory({
            rpc: rpcConnection,
            rpcSubscriptions,
          });

        setMaxListeners(100);

        // Incase we want to abort the promise that's waiting for a tx to be confirmed
        const abortController = new AbortController();

        while (true) {
          const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({ rpc: rpcConnection, rpcSubscriptions });

          try {
            await safeRace([
              sendAndConfirmTransaction(transactionSignedWithFeePayer, { maxRetries: 0n, skipPreflight: true, commitment: "confirmed", abortSignal: abortController.signal }),
              sleep(TX_RETRY_INTERVAL).then(() => {
                throw new Error("TxSendTimeout");
              }),
            ]);

            console.log(`Confirmed tx ${signature}`);

            break;
          } catch (e: any) {
            if (e.message === "TxSendTimeout") {
              console.log(`Tx not confirmed after ${TX_RETRY_INTERVAL * txSendAttempts++}ms, resending`)
              continue;
            } else if (isSolanaError(e, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) {
              throw new Error("TransactionExpiredBlockheightExceededError")
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
          // Same as `if (e.message.includes("Blockhash not found")) {`
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

      // Prepare the payload to send to validators.app
      const vAPayload = JSON.stringify({
        time: txEnd - txStart!,
        signature,
        transaction_type: "transfer",
        success: signature !== FAKE_SIGNATURE,
        application: "web3",
        commitment_level: COMMITMENT_LEVEL,
        slot_sent: BigInt(slotSent!).toString(),
        slot_landed: BigInt(slotLanded!).toString(),
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
  watchBlockhash(gBlockhash, rpcConnection),
  watchSlotSent(gSlotSent, rpcSubscriptions),
  pingThing(),
]);