// Sample use:
// node ping-thing-client.mjs >> ping-thing.log &

import dotenv from "dotenv";
import web3 from '@solana/web3.js';
import bs58 from 'bs58';
import XMLHttpRequest from 'xhr2';

// Read constants from .env
dotenv.config();
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const USER_PRIVATE_KEY = bs58.decode(process.env.WALLET_PRIVATE_KEYPAIR);
const USER_KEYPAIR = web3.Keypair.fromSecretKey(USER_PRIVATE_KEY);
const SLEEP_MS = process.env.SLEEP_MS;
const VA_API_KEY = process.env.VA_API_KEY;
const VERBOSE_LOG = process.env.VERBOSE_LOG;

const walletAccount = new web3.PublicKey(USER_KEYPAIR.publicKey);
const connection = new web3.Connection(RPC_ENDPOINT, 'confirmed');
const commitmentLevel = 'confirmed';

// Setup our transaction
var tx = new web3.Transaction();
tx.add(
  web3.SystemProgram.transfer({
    fromPubkey: USER_KEYPAIR.publicKey,
    toPubkey: USER_KEYPAIR.publicKey,
    lamports: 5000
  })
);

if (VERBOSE_LOG === true) console.log(`Starting script at ${new Date()}`, '\n');

// Run inside a loop that will exit after 3 consecutive failures
var tryCount = 0;
var maxTries = 3;
while(true) {
  try {
    var txStart = new Date();
    var signature = await web3.sendAndConfirmTransaction(
      connection,
      tx,
      [USER_KEYPAIR],
      { commitment: commitmentLevel }
    );
    var txEnd = new Date();
    var txElapsedMs = txEnd - txStart;

    if (VERBOSE_LOG === true) console.log(`tx: ${JSON.stringify(signature)}`);

    // curl_command = "curl -s -X POST -H \"Token: #{va_token}\" -H \"Content-Type: application/json\" -d '{\"time\": #{time_ms}, \"signature\": \"#{signature}\", \"transaction_type\": \"transfer\", \"success\": #{success}, \"application\": \"CLI\", \"commitment_level\": \"confirmed\"}' https://www.validators.app/api/v1/ping-thing/mainnet"
    const response = new XMLHttpRequest();
    const payload = JSON.stringify({
      time: txElapsedMs,
      signature: signature,
      transaction_type: 'transfer',
      success: true,
      application: 'web3',
      commitment_level: commitmentLevel
    });

    if (VERBOSE_LOG === true) console.log(payload, '\n');

    response.open(
      "POST",
      'https://www.validators.app/api/v1/ping-thing/mainnet'
    );
    response.setRequestHeader('Content-Type', 'application/json');
    response.setRequestHeader('Token', VA_API_KEY);
    response.send(payload);

    // Catch interrupts & exit
    process.on('SIGINT', function() {
      console.log(`Caught interrupt signal at ${new Date()}`, '\n');
      process.exit();
    });

    // Reset the try counter and sleep
    tryCount = 0;
    await new Promise(r => setTimeout(r, SLEEP_MS));

    // TODO -- Sample Errors to catch:
    // SendTransactionError: failed to send transaction: Transaction simulation failed: This transaction has already been processed
    // (node:9231) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 SIGINT listeners added to [process]. Use emitter.setMaxListeners() to increase limit
  } catch (e) {
    console.log('\n', e, '\n');
    if (++tryCount == maxTries) throw e;
  }
}
if (VERBOSE_LOG === true) console.log(`Ending script at ${new Date()}`, '\n');
