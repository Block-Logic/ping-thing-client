import {
  type Address,
  createRpcMessage,
  type RpcApi,
  type RpcPlan,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  type SolanaRpcApiMainnet,
} from "@solana/kit";

// Define the response type for prioritization fees
type PrioritizationFeeResult = {
  slot: number;
  prioritizationFee: number;
};

// Define our custom API interface
type PrioritizationFeesApi = {
  getRecentPrioritizationFeesTriton(
    addresses?: Address[],
    options?: { percentile?: number }
  ): Promise<PrioritizationFeeResult[]>;
};

// Create the customized RPC API
const solanaRpcApi =
  createSolanaRpcApi<SolanaRpcApiMainnet>(DEFAULT_RPC_CONFIG);

const customizedRpcApi = new Proxy(solanaRpcApi, {
  defineProperty() {
    return false;
  },
  deleteProperty() {
    return false;
  },
  get(target, p, receiver): any {
    const methodName = p.toString();
    if (methodName === "getRecentPrioritizationFeesTriton") {
      return (
        addresses: Address[] = [],
        options: { percentile?: number } = {}
      ) => {
        const request = {
          methodName: "getRecentPrioritizationFees",
          params: [
            addresses,
            {
              percentile: options.percentile || 0,
            },
          ],
        };

        return {
          // @ts-ignore
          execute: async ({ signal, transport }) => {
            const response = await transport({
              payload: createRpcMessage(request),
              signal,
            });
            return response.result as PrioritizationFeeResult[];
          },
        };
      };
    } else {
      return Reflect.get(target, p, receiver);
    }
  },
}) as RpcApi<SolanaRpcApiMainnet & PrioritizationFeesApi>;

export { customizedRpcApi, type PrioritizationFeesApi };
