// Sample use:
// node ping-thing-client-token.mjs >> ping-thing-token.log 2>&1 &
//
// This script will send a small token transfer between two ATAs of the same type. You need to
// create the ATAs in advance and put the ATA addresses in the .env file.

import dotenv from "dotenv";
import { Connection, Keypair, Transaction, ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { createTransferInstruction } from "@solana/spl-token";

import bs58 from "bs58";
import axios from "axios";
import { watchBlockhash } from "./utils/blockhash.mjs";
import { watchSlotSent } from "./utils/slot.mjs";
import { sleep } from "./utils/misc.mjs";

// Catch interrupts & exit
process.on("SIGINT", function () {
  console.log(`${new Date().toISOString()} Caught interrupt signal`, "\n");
  process.exit();
});

// Read constants from .env
dotenv.config();
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const USER_KEYPAIR = Keypair.fromSecretKey(
  bs58.decode(process.env.WALLET_PRIVATE_KEYPAIR),
);

const VERBOSE_LOG = process.env.VERBOSE_LOG === "true" ? true : false;
if (VERBOSE_LOG) console.log(`${new Date().toISOString()} Starting script`);

const SLEEP_MS_RPC = process.env.SLEEP_MS_RPC || 2000;
const SLEEP_MS_LOOP = process.env.SLEEP_MS_LOOP || 0;
const VA_API_KEY = process.env.VA_API_KEY;
// process.env.VERBOSE_LOG returns a string. e.g. 'true'
const COMMITMENT_LEVEL = process.env.COMMITMENT || "confirmed";
const USE_PRIORITY_FEE = process.env.USE_PRIORITY_FEE == "true" ? true : false;
const ATA_SEND = new PublicKey(process.env.ATA_SEND);
const ATA_REC = new PublicKey(process.env.ATA_REC);
const ATA_AMT = BigInt(process.env.ATA_AMT);

// Set up web3 client
const connection = new Connection(RPC_ENDPOINT, {
  commitment: COMMITMENT_LEVEL,
});

const gBlockhash = { value: null, updated_at: 0 };

// Record new slot on `firstShredReceived`
const gSlotSent = { value: null, updated_at: 0 };

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

    // Wait fresh data
    while (true) {
      if (
        Date.now() - gBlockhash.updated_at < 10000
      ) {
        blockhash = gBlockhash.value;
        break;
      }

      await sleep(1);
    }

    try {
      try {
        // Setup our transaction
        const tx = new Transaction();
        if (USE_PRIORITY_FEE) {
          tx.add(
            ComputeBudgetProgram.setComputeUnitLimit({
              units: process.env.CU_BUDGET || 5000,
            }),
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: process.env.PRIORITY_FEE_MICRO_LAMPORTS || 3,
            }),
          );
        }
        tx.add(
          createTransferInstruction(
            ATA_SEND,
            ATA_REC,
            USER_KEYPAIR.publicKey,
            ATA_AMT
          ),
        );

        // Sign
        tx.lastValidBlockHeight = blockhash.lastValidBlockHeight;
        tx.recentBlockhash = blockhash.blockhash;
        tx.sign(USER_KEYPAIR);

        // Send and wait confirmation
        slotSent = await connection.getSlot('processed');
        txStart = Date.now();
        signature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
        });
        const result = await connection.confirmTransaction(
          {
            signature,
            blockhash: tx.recentBlockhash,
            lastValidBlockHeight: tx.lastValidBlockHeight,
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
        transaction_type: "transfer",
        success: signature !== FAKE_SIGNATURE,
        application: "web3",
        commitment_level: COMMITMENT_LEVEL,
        slot_sent: slotSent,
        slot_landed: slotLanded,
      });
      if (VERBOSE_LOG) {
        console.log(`${new Date().toISOString()} ${vAPayload}`);
      }

      // Send the payload to validators.app
      const vaResponse = await axios.post("https://www.validators.app/api/v1/ping-thing/mainnet", vAPayload, {
        headers: {
          "Content-Type": "application/json",
          "Token": VA_API_KEY
        }
      });
      // throw error if response is not ok
      if (!(vaResponse.status >= 200 && vaResponse.status <= 299)) {
        throw new Error(`Failed to update validators: ${vaResponse.status}`);
      }

      if (VERBOSE_LOG) {
        console.log(`${new Date().toISOString()} VA Response ${vaResponse.status} ${JSON.stringify(vaResponse.data)}`);
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

await Promise.all([watchBlockhash(gBlockhash, connection), watchSlotSent(gSlotSent, connection), pingThing()]);