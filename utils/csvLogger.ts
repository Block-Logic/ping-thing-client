import fs from "fs";
import path from "path";

const CSV_DIR = "results";

// Create a single timestamp when the module is loaded
const SCRIPT_START_TIME = Math.floor(Date.now() / 1000);

export const appendToResultsCsv = (
  slotSent: number,
  sequenceNumber: number,
  signature: string
) => {
  // Create results directory if it doesn't exist
  if (!fs.existsSync(CSV_DIR)) {
    fs.mkdirSync(CSV_DIR);
  }

  // Use the script start time for the filename
  const filename = path.join(CSV_DIR, `${SCRIPT_START_TIME}.csv`);

  // Check if file exists to determine if we need to write headers
  const fileExists = fs.existsSync(filename);

  // Prepare the data row
  const data = `${slotSent},${sequenceNumber},${signature}\n`;

  if (!fileExists) {
    // Write headers if file doesn't exist
    const headers = "slot_sent,sequence_number,signature\n";
    fs.writeFileSync(filename, headers + data);
  } else {
    // Append data if file exists
    fs.appendFileSync(filename, data);
  }
};
