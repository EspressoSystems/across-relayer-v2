import assert from "assert";
import {
  Contract,
  BigNumber,
  BigNumberish,
  TransactionResponse,
  Event,
  checkAddressChecksum,
  ethers,
} from "../../../utils";
import { spreadEventWithBlockNumber, assign, winston } from "../../../utils";
import { SpokePoolClient } from "../..";
import { BaseAdapter } from "..";
import { SortableEvent } from "../../../interfaces";
import { OutstandingTransfers } from "../../../interfaces";
import { CONTRACT_ADDRESSES } from "../../../common";
import { constants } from "@across-protocol/sdk-v2";
import { OpStackBridge } from "./OpStackBridgeInterface";
import { WethBridge } from "./WethBridge";
import { DefaultERC20Bridge } from "./DefaultErc20Bridge";

const { TOKEN_SYMBOLS_MAP } = constants;

export class OpStackAdapter extends BaseAdapter {
  public l2Gas: number;
  private readonly defaultBridge: OpStackBridge;

  constructor(
    chainId: number,
    private customBridges: { [l1Address: string]: OpStackBridge },
    logger: winston.Logger,
    supportedTokens: string[],
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[],
    // Optional sender address where the cross chain transfers originate from. This is useful for the use case of
    // monitoring transfers from HubPool to SpokePools where the sender is HubPool.
    readonly senderAddress?: string
  ) {
    super(spokePoolClients, chainId, monitoredAddresses, logger, supportedTokens);
    this.l2Gas = 200000;

    // Typically, a custom WETH bridge is not provided, so use the standard one.
    const wethAddress = TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubChainId];
    if (wethAddress && !this.customBridges[wethAddress]) {
      this.customBridges[wethAddress] = new WethBridge(
        this.chainId,
        this.hubChainId,
        this.getSigner(this.hubChainId),
        this.getSigner(chainId)
      );
    }

    this.defaultBridge = new DefaultERC20Bridge(
      this.chainId,
      this.hubChainId,
      this.getSigner(this.hubChainId),
      this.getSigner(chainId)
    );

    // Before using this mapping, we need to verify that every key is a correctly checksummed address.
    assert(
      Object.keys(this.customBridges).every(checkAddressChecksum),
      `Invalid or non-checksummed bridge address in customBridges keys: ${Object.keys(this.customBridges)}`
    );
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: l1SearchConfig, l2Config: l2SearchConfig });

    const processEvent = (event: Event) => {
      const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
        _amount: BigNumberish;
        _to: string;
      };
      return {
        amount: eventSpread["_amount"],
        to: eventSpread["_to"],
        ...eventSpread,
      };
    };

    await Promise.all(
      this.monitoredAddresses.map((monitoredAddress) =>
        Promise.all(
          l1Tokens.map(async (l1Token) => {
            const bridge = this.getBridge(l1Token);

            const [depositInitiatedResults, depositFinalizedResults, depositFinalizedResults_DepositAdapter] =
              await Promise.all([
                bridge.queryL1BridgeInitiationEvents(l1Token, monitoredAddress, l1SearchConfig),
                bridge.queryL2BridgeFinalizationEvents(l1Token, monitoredAddress, l2SearchConfig),
                // Transfers might have come from the monitored address itself or another sender address (if specified).
                bridge.queryL2BridgeFinalizationEvents(
                  l1Token,
                  this.senderAddress || this.atomicDepositorAddress,
                  l2SearchConfig
                ),
              ]);

            assign(
              this.l1DepositInitiatedEvents,
              [monitoredAddress, l1Token],
              depositInitiatedResults.map(processEvent)
            );
            assign(
              this.l2DepositFinalizedEvents,
              [monitoredAddress, l1Token],
              depositFinalizedResults.map(processEvent)
            );
            assign(
              this.l2DepositFinalizedEvents_DepositAdapter,
              [monitoredAddress, l1Token],
              depositFinalizedResults_DepositAdapter.map(processEvent)
            );
          })
        )
      )
    );

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;
    this.baseL1SearchConfig.fromBlock = l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(l1Tokens);
  }

  async sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode = false
  ): Promise<TransactionResponse> {
    const { l2Gas } = this;

    const bridge = this.getBridge(l1Token);

    const { contract, method, args } = bridge.constructL1ToL2Txn(address, l1Token, l2Token, amount, l2Gas);

    // Pad gas when bridging to Optimism/Base: https://community.optimism.io/docs/developers/bedrock/differences
    const gasLimitMultiplier = 1.5;
    return await this._sendTokenToTargetChain(
      l1Token,
      l2Token,
      amount,
      contract,
      method,
      args,
      gasLimitMultiplier,
      ethers.constants.Zero,
      simMode
    );
  }

  async wrapEthIfAboveThreshold(threshold: BigNumber, simMode = false): Promise<TransactionResponse | null> {
    const { chainId } = this;
    assert(chainId === this.chainId, `chainId ${chainId} is not supported`);

    const ovmWeth = CONTRACT_ADDRESSES[this.chainId].weth;
    const ethBalance = await this.getSigner(chainId).getBalance();
    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(chainId);
      const contract = new Contract(ovmWeth.address, ovmWeth.abi, l2Signer);
      const value = ethBalance.sub(threshold);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, value, ethBalance });
      return await this._wrapEthIfAboveThreshold(threshold, contract, value, simMode);
    }
    return null;
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    // We need to approve the Atomic depositor to bridge WETH to optimism via the ETH route.
    const associatedL1Bridges = l1Tokens.map((l1Token) => this.getBridge(l1Token).l1Gateway);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  getBridge(l1Token: string): OpStackBridge {
    // Before doing a lookup, we must verify that the address is correctly checksummed.
    assert(checkAddressChecksum(l1Token), `Invalid or non-checksummed token address ${l1Token}`);
    return this.customBridges[l1Token] || this.defaultBridge;
  }
}