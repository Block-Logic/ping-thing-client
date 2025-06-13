import fs from "fs";
import path from "path";
import {
  createRpc,
  createDefaultRpcTransport,
  type Signature,
} from "@solana/kit";
import { customizedRpcApi } from "../utils/grpfCustomRpcApi.js";
import dotenv from "dotenv";

dotenv.config();

const RPC_ENDPOINT = process.env.RPC_ENDPOINT!;
const RESULTS_DIR = "results";

interface TransactionRecord {
  slot_sent: number;
  sequence_number: number;
  signature: string;
}

interface AnalyzedRecord extends TransactionRecord {
  slot_landed: bigint;
  slot_latency: bigint;
}

async function analyzeSlotLatency() {
  // Initialize RPC connection
  const rpcConnection = createRpc({
    api: customizedRpcApi,
    transport: createDefaultRpcTransport({ url: RPC_ENDPOINT }),
  });

  // Get all CSV files from results directory that match unixtimestamp.csv pattern
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter(
      (file) =>
        file.endsWith(".csv") &&
        !file.startsWith("analyzedSlotLatency_") &&
        /^\d+\.csv$/.test(file)
    );

  for (const file of files) {
    const inputPath = path.join(RESULTS_DIR, file);
    const outputPath = path.join(RESULTS_DIR, `analyzedSlotLatency_${file}`);

    // Read and parse the input CSV
    const content = fs.readFileSync(inputPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    const headers = lines[0].split(",");
    const records: TransactionRecord[] = lines.slice(1).map((line) => {
      const [slot_sent, sequence_number, signature] = line.split(",");
      return {
        slot_sent: parseInt(slot_sent),
        sequence_number: parseInt(sequence_number),
        signature,
      };
    });

    // Process each record
    const analyzedRecords: AnalyzedRecord[] = [];
    for (const record of records) {
      try {
        // Get transaction details from RPC
        const tx = await rpcConnection
          .getTransaction(record.signature as Signature, {
            maxSupportedTransactionVersion: 0,
          })
          .send();

        if (tx) {
          const slot_landed = tx.slot;
          const slot_latency = BigInt(slot_landed) - BigInt(record.slot_sent);

          analyzedRecords.push({
            ...record,
            slot_landed,
            slot_latency,
          });

          console.log(
            `Processed ${record.signature}: Latency = ${slot_latency} slots`
          );
        } else {
          console.log(`Transaction not found: ${record.signature}`);
        }
      } catch (error) {
        console.error(`Error processing ${record.signature}:`, error);
      }
    }

    // Write results to output CSV
    const outputHeaders =
      "slot_sent,slot_landed,sequence_number,signature,slot_latency\n";
    const outputContent =
      outputHeaders +
      analyzedRecords
        .map(
          (record) =>
            `${record.slot_sent},${record.slot_landed},${record.sequence_number},${record.signature},${record.slot_latency}`
        )
        .join("\n");

    fs.writeFileSync(outputPath, outputContent);
    console.log(`Analysis complete. Results written to ${outputPath}`);
  }
}

// Run the analysis
analyzeSlotLatency().catch(console.error);
