import { createRpc, createDefaultRpcTransport, address } from "@solana/kit";
import { customizedRpcApi } from "../utils/grpfCustomRpcApi.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";

dotenv.config();

const TARGET_ACCOUNT = "7CNENyTGLXp2rhf1DHFLczeB6A7yxukK8tCaa5Zk5uj6";
const RESULTS_DIR = "results";

async function analyzeSequence() {
  // Initialize RPC connection
  const rpcConnection = createRpc({
    api: customizedRpcApi,
    transport: createDefaultRpcTransport({ url: process.env.RPC_ENDPOINT! }),
  });

  // Read all CSV files from results directory that match unixtimestamp.csv pattern
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((file) => file.endsWith(".csv") && /^\d+\.csv$/.test(file));

  for (const file of files) {
    console.log(`\nAnalyzing file: ${file}`);

    // Create output CSV file with headers for this input file
    const outputPath = path.join(RESULTS_DIR, `sequence_analysis_${file}`);
    fs.writeFileSync(
      outputPath,
      "slot_sent,slot_landed,slot_latency,sequence_number,signature\n"
    );

    // Read and parse CSV
    const csvContent = fs.readFileSync(path.join(RESULTS_DIR, file), "utf-8");
    const inputRecords = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
    });

    if (inputRecords.length === 0) {
      console.log("No records found in CSV");
      continue;
    }

    // Get first and last slot
    const firstSlot = parseInt(inputRecords[0].slot_sent);
    const lastSlot = parseInt(inputRecords[inputRecords.length - 1].slot_sent);
    const endSlot = lastSlot + 20; // Add 20 more blocks

    console.log(`Analyzing blocks from slot ${firstSlot} to ${endSlot}`);

    // Process blocks sequentially
    for (let slot = firstSlot; slot <= endSlot; slot++) {
      try {
        console.log(`\nProcessing block ${slot}...`);

        const block = await rpcConnection
          .getBlock(BigInt(slot), {
            encoding: "json",
            maxSupportedTransactionVersion: 0,
            transactionDetails: "full",
            rewards: false,
          })
          .send();

        if (!block) {
          console.log(`No block found for slot ${slot}`);
          continue;
        }

        // Process transactions sequentially
        for (const tx of block.transactions) {
          if (!tx.meta) continue;

          const accountKeys = tx.transaction.message.accountKeys;
          if (accountKeys.includes(address(TARGET_ACCOUNT))) {
            // Parse memo data from logs
            const memoLog = tx.meta.logMessages?.find((log: string) =>
              log.includes("Program log: Memo")
            );

            if (memoLog) {
              const match = memoLog.match(/Memo \(len \d+\): "(\d+),(\d+)"/);
              if (match) {
                const [_, slotSent, sequenceNumber] = match;
                const slotLanded = BigInt(block.parentSlot) + 1n;
                const slotLatency = slotLanded - BigInt(slotSent);

                // Append directly to CSV
                const csvLine = `${slotSent},${slotLanded},${slotLatency},${sequenceNumber},${tx.transaction.signatures[0]}\n`;
                fs.appendFileSync(outputPath, csvLine);

                console.log(`Found transaction in slot ${slot}:`);
                console.log(`Slot Sent: ${slotSent}`);
                console.log(`Slot Landed: ${slotLanded}`);
                console.log(`Slot Latency: ${slotLatency}`);
                console.log(`Sequence Number: ${sequenceNumber}`);
                console.log(`Signature: ${tx.transaction.signatures[0]}`);
              }
            }
          }
        }
      } catch (error: any) {
        console.log(`Error fetching block ${slot}: ${error.message}`);
      }
    }

    console.log(
      `\nAnalysis complete for ${file}. Results written to sequence_analysis_${file}`
    );
  }
}

// Run the analysis
analyzeSequence().catch(console.error);
