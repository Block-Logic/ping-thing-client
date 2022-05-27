// Sample use:
// node ping-thing-client.mjs >> ping-thing.log 2>&1 &

import dotenv from "dotenv";
import web3 from '@solana/web3.js';
import bs58 from 'bs58';
import XMLHttpRequest from 'xhr2';

// Catch interrupts & exit
process.on(
  'SIGINT',
  function() {
    console.log(`Caught interrupt signal at ${new Date()}`, '\n');
    process.exit();
  }
);

// Read constants from .env
dotenv.config();
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const USER_KEYPAIR = web3.Keypair.fromSecretKey(
                       bs58.decode(process.env.WALLET_PRIVATE_KEYPAIR)
                     );
const SLEEP_MS = process.env.SLEEP_MS;
const VA_API_KEY = process.env.VA_API_KEY;
const VERBOSE_LOG = process.env.VERBOSE_LOG;

// Set up web3 client
const walletAccount = new web3.PublicKey(USER_KEYPAIR.publicKey);
const connection = new web3.Connection(RPC_ENDPOINT, 'confirmed');
const commitmentLevel = 'confirmed';

// Set up our REST client
const restClient = new XMLHttpRequest();

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
    // Send the TX to the cluster
    var txStart = new Date();
    try {
      var signature = await web3.sendAndConfirmTransaction(
        connection,
        tx,
        [USER_KEYPAIR],
        { commitment: commitmentLevel }
      );
      var txSuccess = true;
    } catch (e) {
      // TODO -- Sample Errors to catch:
      // TransactionExpiredBlockheightExceededError: Signature vxvewmXNthUacKXHaAu9XyduSgJ5DiVFS2UqzM1Q8z5D1cUZAKvXGZDhzDW9kn2mqADjfwy4iBExE1Je1im72AA has expired: block height exceeded.
      // SendTransactionError: failed to send transaction: Transaction simulation failed: This transaction has already been processed

      if (e.message.includes('new blockhash')) {
        console.log('ERROR: Unable to obtain a new blockhash');
        continue;
      }

      if (e.message.includes('Blockhash not found')) {
        console.log('ERROR: Blockhash not found');
        continue;
      }

      if (e.name == 'TransactionExpiredBlockheightExceededError') {
        console.log('ERROR: Blockhash expired/block height exceeded.');
        continue;
      }

      console.log('TX ERROR:');
      console.log(e);
      console.log(e.message);
      console.log(JSON.stringify(e));
      var txSuccess = false;
      var signature = '';
    } finally {
      var txEnd = new Date();
    }
    var txElapsedMs = txEnd - txStart;

    // prepare the payload to send to validators.app
    const payload = JSON.stringify({
      time: txElapsedMs,
      signature: signature,
      transaction_type: 'transfer',
      success: txSuccess,
      application: 'web3',
      commitment_level: commitmentLevel
    });

    if (VERBOSE_LOG === true) {
      console.log(`${new Date().toISOString()} => ${payload}`);
    }

    // Send the ping data to validators.app
    restClient.open(
      "POST",
      'https://www.validators.app/api/v1/ping-thing/mainnet'
    );
    restClient.setRequestHeader('Content-Type', 'application/json');
    restClient.setRequestHeader('Token', VA_API_KEY);
    restClient.send(payload);

    // Reset the try counter and sleep
    tryCount = 0;
    await new Promise(r => setTimeout(r, SLEEP_MS));
  } catch (e) {
    console.log('\n', e, '\n');
    if (++tryCount == maxTries) throw e;
  }
}

if (VERBOSE_LOG === true) console.log(`Ending script at ${new Date()}`, '\n');
