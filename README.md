 # ping-thing-client
Node JS Client to contribute ping times to the Validators.app Ping Thing.

## Install notes
`git clone https://github.com/Block-Logic/ping-thing-client.git`
`cd ping-thing-client/`

Try `yarn install`. If that doesn't work, use:
`yarn add @solana/web3.js`
`yarn add dotenv`
`yarn add xhr2`

I use .env to hold sensitive data that I don't want to appear in the GitHub repo. Copy .env.sample to .env and replace the values inside the file with your data. The .env file needs your private wallet keypair in base58 format. There is a simple Ruby script that will convert a keypair.json file into base58. See keypair_to_base58.rb

Before you can post pings to validators.app, you will need an API key. You can sign up at https://www.validators.app/users/sign_up and grab a free API key from your dashboard. Note: Your login handle will be displayed on the public Ping Thing page.

After retrieving your API key, copy & paste it into the VA_API_KEY attribute of your .env file.

In the .env file, try `VERBOSE_LOG=true` to see log output the first time you run the script. After saving your .env file, try running the script with `node ping-thing-client.mjs` and watch the output. I use `VERBOSE_LOG=false` in production to minimize log noise.

## Running the Ping Thing Script
You can start the script & push it to the background with `node ping-thing-client.mjs >> ping-thing.log 2>&1 &`.


## RPC Notes
If you are running the Ping Thing client on your validator node, you need to enable private RPC for access from your localhost. You also need to enable `--enable-rpc-transaction-history` to get the TX slot after confirmation.

### Misc Notes
https://www.digitalocean.com/community/tutorials/how-to-install-node-js-on-ubuntu-20-04
