# ping-thing-client
This ping thing client is monotonic. It adds a memo instruction to the transactions with the slot_sent for the transaction and an incremental sequence_number. Both of these are used to check the order of the transaction in a block relative to slot latency.

Transactions are sent with a configurable delay in between in a spray-and-pray manner, the script does not wait for confirmations. It assumes that you are setting high enough priority fees and are sending transactions via a well staked route

## Install notes
`git clone https://github.com/Block-Logic/ping-thing-client.git`
`cd ping-thing-client/`

Install Dependencies
`pnpm install`

Run
`tsx ping-thing-client.tsx`

## Analysis
1. The ping thing script produces a file in the `results` directory `<unix-timestamp>.csv` with the following fields
```
slot_sent,sequence_number,signature
```
2. The `analysis/slotLatencyCalculator.ts` file measures the slot latency of a transaction and produces a CSV file with the following fields
```
slot_sent,slot_landed,sequence_number,signature,slot_latency
```
3. The `analysis/sequenceAnalyzer.ts` file fetches blocks from `first_slot_in_csv` to `last_slot_in_csv+20` and sequentially iterates over the transactions and for every transaction it logs the following in a CSV file
```
slot_sent,slot_landed,slot_latency,sequence_number,signature
```