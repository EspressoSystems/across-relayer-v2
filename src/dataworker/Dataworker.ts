import assert from "assert";
import { utils as ethersUtils } from "ethers";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import {
  bnZero,
  winston,
  EMPTY_MERKLE_ROOT,
  sortEventsDescending,
  BigNumber,
  getNetworkName,
  getRefund,
  MerkleTree,
  sortEventsAscending,
  isDefined,
  toBNWei,
  getFillsInRange,
  ZERO_ADDRESS,
} from "../utils";
import {
  FillsToRefund,
  ProposedRootBundle,
  RootBundleRelayWithBlock,
  SlowFillLeaf,
  SpokePoolClientsByChain,
  UnfilledDeposit,
  PendingRootBundle,
  RunningBalances,
  PoolRebalanceLeaf,
  RelayerRefundLeaf,
  V2SlowFillLeaf,
  V3SlowFillLeaf,
  V2DepositWithBlock,
  V2FillWithBlock,
} from "../interfaces";
import { DataworkerClients } from "./DataworkerClientHelper";
import { SpokePoolClient, BalanceAllocator } from "../clients";
import * as PoolRebalanceUtils from "./PoolRebalanceUtils";
import {
  blockRangesAreInvalidForSpokeClients,
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
  l2TokensToCountTowardsSpokePoolLeafExecutionCapital,
} from "../dataworker/DataworkerUtils";
import {
  getEndBlockBuffers,
  _buildPoolRebalanceRoot,
  _buildRelayerRefundRoot,
  _buildSlowRelayRoot,
} from "./DataworkerUtils";
import _ from "lodash";
import { spokePoolClientsToProviders } from "../common";
import * as sdk from "@across-protocol/sdk-v2";
import {
  BundleDepositsV3,
  BundleExcessSlowFills,
  BundleFillsV3,
  BundleSlowFills,
  ExpiredDepositsToRefundV3,
} from "../interfaces/BundleData";

// Internal error reasons for labeling a pending root bundle as "invalid" that we don't want to submit a dispute
// for. These errors are due to issues with the dataworker configuration, instead of with the pending root
// bundle. Any reasons in IGNORE_X we emit a "debug" level log for, and any reasons in ERROR_X we emit an "error"
// level log for.
const IGNORE_DISPUTE_REASONS = new Set(["bundle-end-block-buffer"]);
const ERROR_DISPUTE_REASONS = new Set(["insufficient-dataworker-lookback", "out-of-date-config-store-version"]);

// Create a type for storing a collection of roots
type RootBundle = {
  leaves: SlowFillLeaf[];
  tree: MerkleTree<SlowFillLeaf>;
};

type ProposeRootBundleReturnType = {
  poolRebalanceLeaves: PoolRebalanceLeaf[];
  poolRebalanceTree: MerkleTree<PoolRebalanceLeaf>;
  relayerRefundLeaves: RelayerRefundLeaf[];
  relayerRefundTree: MerkleTree<RelayerRefundLeaf>;
  slowFillLeaves: SlowFillLeaf[];
  slowFillTree: MerkleTree<SlowFillLeaf>;
};

export type PoolRebalanceRoot = {
  runningBalances: RunningBalances;
  realizedLpFees: RunningBalances;
  leaves: PoolRebalanceLeaf[];
  tree: MerkleTree<PoolRebalanceLeaf>;
};

type PoolRebalanceRootCache = Record<string, PoolRebalanceRoot>;

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  rootCache: PoolRebalanceRootCache = {};

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: DataworkerClients,
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly maxRefundCountOverride: number | undefined,
    readonly maxL1TokenCountOverride: number | undefined,
    readonly blockRangeEndBlockBuffer: { [chainId: number]: number } = {},
    readonly spokeRootsLookbackCount = 0,
    readonly bufferToPropose = 0,
    readonly forceProposal = false,
    readonly forceBundleRange?: [number, number][]
  ) {
    if (
      maxRefundCountOverride !== undefined ||
      maxL1TokenCountOverride !== undefined ||
      Object.keys(blockRangeEndBlockBuffer).length > 0
    ) {
      this.logger.debug({
        at: "Dataworker#Constructor",
        message: "Dataworker constructed with overridden config store settings",
        chainIdListForBundleEvaluationBlockNumbers,
        maxRefundCountOverride: this.maxRefundCountOverride,
        maxL1TokenCountOverride: this.maxL1TokenCountOverride,
        blockRangeEndBlockBuffer: this.blockRangeEndBlockBuffer,
      });
    }
  }

  isV3(blockNumber: number): boolean {
    const versionAtBlock = this.clients.configStoreClient.getConfigStoreVersionForBlock(blockNumber);
    return sdk.utils.isV3(versionAtBlock);
  }

  // This should be called whenever it's possible that the loadData information for a block range could have changed.
  // For instance, if the spoke or hub clients have been updated, it probably makes sense to clear this to be safe.
  clearCache(): void {
    this.clients.bundleDataClient.clearCache();
    this.rootCache = {};
  }

  async buildSlowRelayRoot(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient }
  ): Promise<RootBundle> {
    const { unfilledDeposits, bundleSlowFillsV3 } = await this.clients.bundleDataClient.loadData(
      blockRangesForChains,
      spokePoolClients
    );
    return _buildSlowRelayRoot(unfilledDeposits, bundleSlowFillsV3);
  }

  async buildRelayerRefundRoot(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    poolRebalanceLeaves: PoolRebalanceLeaf[],
    runningBalances: RunningBalances
  ): Promise<{
    leaves: RelayerRefundLeaf[];
    tree: MerkleTree<RelayerRefundLeaf>;
  }> {
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForChains,
      this.clients.hubPoolClient.chainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    const { fillsToRefund, bundleFillsV3, expiredDepositsToRefundV3 } = await this.clients.bundleDataClient.loadData(
      blockRangesForChains,
      spokePoolClients
    );
    const maxRefundCount = this.maxRefundCountOverride
      ? this.maxRefundCountOverride
      : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
    return _buildRelayerRefundRoot(
      endBlockForMainnet,
      fillsToRefund,
      bundleFillsV3,
      expiredDepositsToRefundV3,
      poolRebalanceLeaves,
      runningBalances,
      this.clients,
      maxRefundCount
    );
  }

  // This method is only used in testing and scripts, not to propose new bundles.
  async buildPoolRebalanceRoot(
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain,
    latestMainnetBlock?: number
  ): Promise<PoolRebalanceRoot> {
    const {
      fillsToRefund,
      deposits,
      allValidFills,
      unfilledDeposits,
      earlyDeposits,
      bundleDepositsV3,
      bundleFillsV3,
      bundleSlowFillsV3,
      unexecutableSlowFills,
      expiredDepositsToRefundV3,
    } = await this.clients.bundleDataClient.loadData(blockRangesForChains, spokePoolClients);

    const mainnetBundleEndBlock = getBlockRangeForChain(
      blockRangesForChains,
      this.clients.hubPoolClient.chainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesForChains,
      this.chainIdListForBundleEvaluationBlockNumbers
    );

    return await this._getPoolRebalanceRoot(
      spokePoolClients,
      blockRangesForChains,
      latestMainnetBlock ?? mainnetBundleEndBlock,
      mainnetBundleEndBlock,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      earlyDeposits,
      bundleDepositsV3,
      bundleFillsV3,
      bundleSlowFillsV3,
      unexecutableSlowFills,
      expiredDepositsToRefundV3,
      true
    );
  }

  shouldWaitToPropose(
    mainnetBundleEndBlock: number,
    bufferToPropose: number = this.bufferToPropose
  ): { shouldWait: boolean; [key: string]: unknown } {
    // Wait until all pool rebalance leaf executions from previous bundle are older than the new mainnet
    // bundle end block. This avoids any complications where a bundle is unable to determine the most recently
    // validated bundle. The HubPoolClient treats a bundle as "validated" once all of its pool rebalance leaves
    // are executed so we want to make sure that these are all older than the mainnet bundle end block which is
    // sometimes treated as the "latest" mainnet block.
    const mostRecentProposedRootBundle = this.clients.hubPoolClient.getLatestFullyExecutedRootBundle(
      this.clients.hubPoolClient.latestBlockSearched
    );

    // If there has never been a validated root bundle, then we can always propose a new one:
    if (mostRecentProposedRootBundle === undefined) {
      return {
        shouldWait: false,
      };
    }

    // Look for any executed leaves up to mainnet bundle end block. If they have been executed but they are not later
    // than the mainnet bundle end block, then we won't see them and we should wait.
    const executedPoolRebalanceLeaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(
      mostRecentProposedRootBundle,
      mainnetBundleEndBlock
    );
    const expectedPoolRebalanceLeaves = mostRecentProposedRootBundle.poolRebalanceLeafCount;
    if (expectedPoolRebalanceLeaves === 0) {
      throw new Error("Pool rebalance leaf count must be > 0");
    }
    const poolRebalanceLeafExecutionBlocks = executedPoolRebalanceLeaves.map((execution) => execution.blockNumber);

    // If any leaves are unexecuted, we should wait. This can also happen if the most recent proposed root bundle
    // was disputed or is still pending in the challenge period.
    if (expectedPoolRebalanceLeaves !== executedPoolRebalanceLeaves.length) {
      return {
        shouldWait: true,
        poolRebalanceLeafExecutionBlocks,
        mainnetBundleEndBlock,
        mostRecentProposedRootBundle: mostRecentProposedRootBundle.transactionHash,
        expectedPoolRebalanceLeaves,
        executedPoolRebalanceLeaves: executedPoolRebalanceLeaves.length,
      };
    }
    // We should now only wait if not enough time (e.g. the bufferToPropose # of seconds) has passed since the last
    // pool rebalance leaf was executed.
    else {
      // `poolRebalanceLeafExecutionBlocks` must have at least one element so the following computation will produce
      // a number.
      const latestExecutedPoolRebalanceLeafBlock = Math.max(...poolRebalanceLeafExecutionBlocks);
      const minimumMainnetBundleEndBlockToPropose = latestExecutedPoolRebalanceLeafBlock + bufferToPropose;
      return {
        shouldWait: mainnetBundleEndBlock < minimumMainnetBundleEndBlockToPropose,
        bufferToPropose,
        poolRebalanceLeafExecutionBlocks,
        mainnetBundleEndBlock,
        minimumMainnetBundleEndBlockToPropose,
        mostRecentProposedRootBundle: mostRecentProposedRootBundle.transactionHash,
      };
    }
  }

  /**
   * Returns the next bundle block ranges if a new proposal is possible, otherwise
   * returns undefined.
   * @param spokePoolClients
   * @param earliestBlocksInSpokePoolClients Earliest blocks loaded in SpokePoolClients. Used to determine severity
   * of log level
   * @returns Array of blocks ranges to propose for next bundle.
   */
  async _getNextProposalBlockRanges(
    spokePoolClients: SpokePoolClientsByChain,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<number[][] | undefined> {
    const { configStoreClient, hubPoolClient } = this.clients;

    // Check if a bundle is pending.
    if (!hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient not updated");
    }
    if (!this.forceProposal && hubPoolClient.hasPendingProposal()) {
      this.logger.debug({ at: "Dataworker#propose", message: "Has pending proposal, cannot propose" });
      return;
    }

    // If config store version isn't up to date, return early. This is a simple rule that is perhaps too aggressive
    // but the proposer role is a specialized one and the user should always be using updated software.
    if (!configStoreClient.hasLatestConfigStoreVersion) {
      this.logger.warn({
        at: "Dataworker#propose",
        message: "Skipping proposal because missing updated ConfigStore version, are you using the latest code?",
        latestVersionSupported: configStoreClient.configStoreVersion,
        latestInConfigStore: configStoreClient.getConfigStoreVersionForTimestamp(),
      });
      return;
    }

    // Construct a list of ending block ranges for each chain that we want to include
    // relay events for. The ending block numbers for these ranges will be added to a "bundleEvaluationBlockNumbers"
    // list, and the order of chain ID's is hardcoded in the ConfigStore client.
    const nextBundleMainnetStartBlock = hubPoolClient.getNextBundleStartBlockNumber(
      this.chainIdListForBundleEvaluationBlockNumbers,
      hubPoolClient.latestBlockSearched,
      hubPoolClient.chainId
    );
    const blockRangesForProposal = this._getWidestPossibleBlockRangeForNextBundle(
      spokePoolClients,
      nextBundleMainnetStartBlock
    );
    const mainnetBlockRange = getBlockRangeForChain(
      blockRangesForProposal,
      hubPoolClient.chainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    );

    // Exit early if spoke pool clients don't have early enough event data to satisfy block ranges for the
    // potential proposal
    if (
      Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
      (await blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        blockRangesForProposal,
        this.chainIdListForBundleEvaluationBlockNumbers,
        earliestBlocksInSpokePoolClients,
        this.isV3(mainnetBlockRange[0])
      ))
    ) {
      this.logger.warn({
        at: "Dataworke#propose",
        message: "Cannot propose bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
        rootBundleRanges: blockRangesForProposal,
        earliestBlocksInSpokePoolClients,
        spokeClientsEventSearchConfigs: Object.fromEntries(
          Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
        ),
      });
      return;
    }

    return blockRangesForProposal;
  }

  async proposeRootBundle(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    usdThresholdToSubmitNewBundle?: BigNumber,
    submitProposals = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<void> {
    // TODO: Handle the case where we can't get event data or even blockchain data from any chain. This will require
    // some changes to override the bundle block range here, and loadData to skip chains with zero block ranges.
    // For now, we assume that if one blockchain fails to return data, then this entire function will fail. This is a
    // safe strategy but could lead to new roots failing to be proposed until ALL networks are healthy.

    // If we are forcing a bundle range, then we should use that instead of the next proposal block ranges.
    const blockRangesForProposal = isDefined(this.forceBundleRange)
      ? this.forceBundleRange
      : await this._getNextProposalBlockRanges(spokePoolClients, earliestBlocksInSpokePoolClients);

    if (!blockRangesForProposal) {
      return;
    }

    const { chainId: hubPoolChainId, latestBlockSearched } = this.clients.hubPoolClient;
    const mainnetBundleEndBlock = getBlockRangeForChain(
      blockRangesForProposal,
      hubPoolChainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    this.logger.debug({
      at: "Dataworker#propose",
      message: "Proposing root bundle",
      blockRangesForProposal,
    });
    const logData = true;
    const rootBundleData = await this._proposeRootBundle(
      blockRangesForProposal,
      spokePoolClients,
      latestBlockSearched,
      logData
    );

    if (usdThresholdToSubmitNewBundle !== undefined) {
      // Exit early if volume of pool rebalance leaves exceeds USD threshold. Volume includes netSendAmounts only since
      // that is the actual amount sent over bridges. This also mitigates the chance that a RelayerRefundLeaf is
      // published but its refund currency isn't sent over the bridge in a PoolRebalanceLeaf.
      const totalUsdRefund = await PoolRebalanceUtils.computePoolRebalanceUsdVolume(
        rootBundleData.poolRebalanceLeaves,
        this.clients
      );
      if (totalUsdRefund.lt(usdThresholdToSubmitNewBundle)) {
        this.logger.debug({
          at: "Dataworker",
          message: "Root bundle USD volume does not exceed threshold, exiting early 🟡",
          usdThresholdToSubmitNewBundle,
          totalUsdRefund,
          leaves: rootBundleData.poolRebalanceLeaves,
        });
        return;
      } else {
        this.logger.debug({
          at: "Dataworker",
          message: "Root bundle USD volume exceeds threshold! 💚",
          usdThresholdToSubmitNewBundle,
          totalUsdRefund,
        });
      }
    }

    // TODO: Validate running balances in potential new bundle and make sure that important invariants
    // are not violated, such as a token balance being lower than the amount necessary to pay out all refunds,
    // slow fills, and return funds to the HubPool. Can use logic similar to /src/scripts/validateRunningbalances.ts

    const shouldWaitToPropose = this.shouldWaitToPropose(mainnetBundleEndBlock);
    if (shouldWaitToPropose.shouldWait) {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "Waiting to propose new bundle",
        shouldWaitToPropose,
      });
      return;
    } else {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "Proceeding to propose new bundle",
        shouldWaitToPropose,
      });
    }

    if (rootBundleData.poolRebalanceLeaves.length === 0) {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "No pool rebalance leaves, cannot propose",
      });
      return;
    }

    // 4. Propose roots to HubPool contract.
    this.logger.debug({
      at: "Dataworker#propose",
      message: "Enqueing new root bundle proposal txn",
      blockRangesForProposal,
      poolRebalanceLeavesCount: rootBundleData.poolRebalanceLeaves.length,
      poolRebalanceRoot: rootBundleData.poolRebalanceTree.getHexRoot(),
      relayerRefundRoot: rootBundleData.relayerRefundTree.getHexRoot(),
      slowRelayRoot: rootBundleData.slowFillTree.getHexRoot(),
    });
    if (submitProposals) {
      this.enqueueRootBundleProposal(
        hubPoolChainId,
        blockRangesForProposal,
        rootBundleData.poolRebalanceLeaves,
        rootBundleData.poolRebalanceTree.getHexRoot(),
        rootBundleData.relayerRefundLeaves,
        rootBundleData.relayerRefundTree.getHexRoot(),
        rootBundleData.slowFillLeaves,
        rootBundleData.slowFillTree.getHexRoot()
      );
    }
  }

  async _proposeRootBundle(
    blockRangesForProposal: number[][],
    spokePoolClients: SpokePoolClientsByChain,
    latestMainnetBundleEndBlock: number,
    logData = false
  ): Promise<ProposeRootBundleReturnType> {
    const timerStart = Date.now();
    const {
      fillsToRefund,
      deposits,
      allValidFills,
      unfilledDeposits,
      earlyDeposits,
      bundleDepositsV3,
      bundleFillsV3,
      bundleSlowFillsV3,
      unexecutableSlowFills,
      expiredDepositsToRefundV3,
    } = await this.clients.bundleDataClient.loadData(blockRangesForProposal, spokePoolClients, logData);
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesForProposal,
      this.chainIdListForBundleEvaluationBlockNumbers
    );

    const hubPoolChainId = this.clients.hubPoolClient.chainId;
    const mainnetBundleEndBlock = getBlockRangeForChain(
      blockRangesForProposal,
      hubPoolChainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];
    const poolRebalanceRoot = await this._getPoolRebalanceRoot(
      spokePoolClients,
      blockRangesForProposal,
      latestMainnetBundleEndBlock,
      mainnetBundleEndBlock,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      earlyDeposits,
      bundleDepositsV3,
      bundleFillsV3,
      bundleSlowFillsV3,
      unexecutableSlowFills,
      expiredDepositsToRefundV3,
      true
    );
    const relayerRefundRoot = _buildRelayerRefundRoot(
      mainnetBundleEndBlock,
      fillsToRefund,
      bundleFillsV3,
      expiredDepositsToRefundV3,
      poolRebalanceRoot.leaves,
      poolRebalanceRoot.runningBalances,
      this.clients,
      this.maxRefundCountOverride
        ? this.maxRefundCountOverride
        : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(mainnetBundleEndBlock)
    );
    const slowRelayRoot = _buildSlowRelayRoot(unfilledDeposits, bundleSlowFillsV3);

    if (logData) {
      this.logger.debug({
        at: "Dataworker",
        message: `Time to build root bundles for block ranges ${JSON.stringify(blockRangesForProposal)} : ${
          Date.now() - timerStart
        }ms`,
      });
      PoolRebalanceUtils.prettyPrintLeaves(
        this.logger,
        poolRebalanceRoot.tree,
        poolRebalanceRoot.leaves,
        "Pool rebalance"
      );
      PoolRebalanceUtils.prettyPrintLeaves(
        this.logger,
        relayerRefundRoot.tree,
        relayerRefundRoot.leaves,
        "Relayer refund"
      );
      PoolRebalanceUtils.prettyPrintLeaves(this.logger, slowRelayRoot.tree, slowRelayRoot.leaves, "Slow relay");
    }

    return {
      poolRebalanceLeaves: poolRebalanceRoot.leaves,
      poolRebalanceTree: poolRebalanceRoot.tree,
      relayerRefundLeaves: relayerRefundRoot.leaves,
      relayerRefundTree: relayerRefundRoot.tree,
      slowFillLeaves: slowRelayRoot.leaves,
      slowFillTree: slowRelayRoot.tree,
    };
  }

  async validatePendingRootBundle(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    submitDisputes = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<void> {
    if (!this.clients.hubPoolClient.isUpdated || this.clients.hubPoolClient.currentTime === undefined) {
      throw new Error("HubPoolClient not updated");
    }
    const hubPoolChainId = this.clients.hubPoolClient.chainId;

    // Exit early if a bundle is not pending.
    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundle();
    if (pendingRootBundle === undefined) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "No pending proposal, nothing to validate",
      });
      return;
    }

    this.logger.debug({
      at: "Dataworker#validate",
      message: "Found pending proposal",
      pendingRootBundle,
    });

    // Exit early if challenge period timestamp has passed:
    if (this.clients.hubPoolClient.currentTime > pendingRootBundle.challengePeriodEndTimestamp) {
      this.logger.debug({
        at: "Dataworke#validater",
        message: "Challenge period passed, cannot dispute",
        expirationTime: pendingRootBundle.challengePeriodEndTimestamp,
      });
      return;
    }

    const nextBundleMainnetStartBlock = this.clients.hubPoolClient.getNextBundleStartBlockNumber(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.clients.hubPoolClient.latestBlockSearched,
      this.clients.hubPoolClient.chainId
    );
    const widestPossibleExpectedBlockRange = this._getWidestPossibleBlockRangeForNextBundle(
      spokePoolClients,
      // Mainnet bundle start block for pending bundle is the first entry in the first entry.
      nextBundleMainnetStartBlock
    );
    const { valid, reason } = await this.validateRootBundle(
      hubPoolChainId,
      widestPossibleExpectedBlockRange,
      pendingRootBundle,
      spokePoolClients,
      earliestBlocksInSpokePoolClients
    );
    if (!valid) {
      // In the case where the Dataworker config is improperly configured, emit an error level alert so bot runner
      // can get dataworker running ASAP.
      if (ERROR_DISPUTE_REASONS.has(reason)) {
        this.logger.error({
          at: "Dataworker#validate",
          message: "Skipping dispute because of dataworker configuration error that needs to be fixed",
          reason,
        });
      } else if (IGNORE_DISPUTE_REASONS.has(reason)) {
        this.logger.debug({
          at: "Dataworker#validate",
          message: "Skipping dispute because of dataworker configuration error, should resolve itself eventually 😪",
          reason,
        });
      } else {
        this.logger.error({
          at: "Dataworker",
          message: "Submitting dispute 🤏🏼",
          mrkdwn: reason,
        });
        if (submitDisputes) {
          this._submitDisputeWithMrkdwn(hubPoolChainId, reason);
        }
      }
    }
  }

  async validateRootBundle(
    hubPoolChainId: number,
    widestPossibleExpectedBlockRange: number[][],
    rootBundle: PendingRootBundle,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    earliestBlocksInSpokePoolClients: { [chainId: number]: number }
  ): Promise<
    // If valid is false, we get a reason and we might get expected trees.
    | {
        valid: false;
        reason: string;
        expectedTrees?: {
          poolRebalanceTree: {
            tree: MerkleTree<PoolRebalanceLeaf>;
            leaves: PoolRebalanceLeaf[];
          };
          relayerRefundTree: {
            tree: MerkleTree<RelayerRefundLeaf>;
            leaves: RelayerRefundLeaf[];
          };
          slowRelayTree: {
            tree: MerkleTree<SlowFillLeaf>;
            leaves: SlowFillLeaf[];
          };
        };
      }
    // If valid is true, we don't get a reason, and we always get expected trees.
    | {
        valid: true;
        reason: undefined;
        expectedTrees: {
          poolRebalanceTree: {
            tree: MerkleTree<PoolRebalanceLeaf>;
            leaves: PoolRebalanceLeaf[];
          };
          relayerRefundTree: {
            tree: MerkleTree<RelayerRefundLeaf>;
            leaves: RelayerRefundLeaf[];
          };
          slowRelayTree: {
            tree: MerkleTree<SlowFillLeaf>;
            leaves: SlowFillLeaf[];
          };
        };
      }
  > {
    // If pool rebalance root is empty, always dispute. There should never be a bundle with an empty rebalance root.
    if (rootBundle.poolRebalanceRoot === EMPTY_MERKLE_ROOT) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Empty pool rebalance root, submitting dispute",
        rootBundle,
      });
      return {
        valid: false,
        reason: "Disputed pending root bundle with empty pool rebalance root",
      };
    }

    // First, we'll evaluate the pending root bundle's block end numbers.
    if (rootBundle.bundleEvaluationBlockNumbers.length !== widestPossibleExpectedBlockRange.length) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected bundle block range length, disputing",
        widestPossibleExpectedBlockRange,
        pendingEndBlocks: rootBundle.bundleEvaluationBlockNumbers,
      });
      return {
        valid: false,
        reason: "Disputed pending root bundle with incorrect bundle block range length",
      };
    }

    const endBlockBuffers = getEndBlockBuffers(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.blockRangeEndBlockBuffer
    );

    // Make sure that all end blocks are >= expected start blocks. Allow for situation where chain was halted
    // and bundle end blocks hadn't advanced at time of proposal, meaning that the end blocks were equal to the
    // previous end blocks. So, even if by the time the disputer runs, the chain has started advancing again, then
    // the proposed block is at most 1 behind the next expected block range.
    if (
      rootBundle.bundleEvaluationBlockNumbers.some(
        (block, index) => block + 1 < widestPossibleExpectedBlockRange[index][0]
      )
    ) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "A bundle end block is < expected start block, submitting dispute",
        expectedStartBlocks: widestPossibleExpectedBlockRange.map((range) => range[0]),
        pendingEndBlocks: rootBundle.bundleEvaluationBlockNumbers,
      });
      return {
        valid: false,
        reason: PoolRebalanceUtils.generateMarkdownForDisputeInvalidBundleBlocks(
          this.chainIdListForBundleEvaluationBlockNumbers,
          rootBundle,
          widestPossibleExpectedBlockRange,
          endBlockBuffers
        ),
      };
    }

    // If the bundle end block is less than HEAD but within the allowable margin of error into future,
    // then we won't dispute and we'll just exit early from this function.
    if (
      rootBundle.bundleEvaluationBlockNumbers.some((block, index) => block > widestPossibleExpectedBlockRange[index][1])
    ) {
      // If end block is further than the allowable margin of error into the future, then dispute it.
      if (
        rootBundle.bundleEvaluationBlockNumbers.some(
          (block, index) => block > widestPossibleExpectedBlockRange[index][1] + endBlockBuffers[index]
        )
      ) {
        this.logger.debug({
          at: "Dataworker#validate",
          message: "A bundle end block is > latest block + buffer for its chain, submitting dispute",
          expectedEndBlocks: widestPossibleExpectedBlockRange.map((range) => range[1]),
          pendingEndBlocks: rootBundle.bundleEvaluationBlockNumbers,
          endBlockBuffers,
        });
        return {
          valid: false,
          reason: PoolRebalanceUtils.generateMarkdownForDisputeInvalidBundleBlocks(
            this.chainIdListForBundleEvaluationBlockNumbers,
            rootBundle,
            widestPossibleExpectedBlockRange,
            endBlockBuffers
          ),
        };
      } else {
        this.logger.debug({
          at: "Dataworker#validate",
          message: "Cannot validate because a bundle end block is > latest block but within buffer",
          expectedEndBlocks: widestPossibleExpectedBlockRange.map((range) => range[1]),
          pendingEndBlocks: rootBundle.bundleEvaluationBlockNumbers,
          endBlockBuffers,
        });
      }
      return {
        valid: false,
        reason: "bundle-end-block-buffer",
      };
    }

    // The block range that we'll use to construct roots will be the end block specified in the pending root bundle,
    // and the block right after the last valid root bundle proposal's end block. If the proposer didn't use the same
    // start block, then they might have missed events and the roots will be different.
    const blockRangesImpliedByBundleEndBlocks = widestPossibleExpectedBlockRange.map((blockRange, index) => [
      blockRange[0],
      rootBundle.bundleEvaluationBlockNumbers[index],
    ]);
    const mainnetBlockRange = getBlockRangeForChain(
      blockRangesImpliedByBundleEndBlocks,
      hubPoolChainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    );
    // Exit early if spoke pool clients don't have early enough event data to satisfy block ranges for the
    // pending proposal. Log an error loudly so that user knows that disputer needs to increase its lookback.
    if (
      Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
      (await blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        blockRangesImpliedByBundleEndBlocks,
        this.chainIdListForBundleEvaluationBlockNumbers,
        earliestBlocksInSpokePoolClients,
        this.isV3(mainnetBlockRange[0])
      ))
    ) {
      this.logger.debug({
        at: "Dataworke#validate",
        message: "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
        rootBundleRanges: blockRangesImpliedByBundleEndBlocks,
        availableSpokePoolClients: Object.keys(spokePoolClients),
        earliestBlocksInSpokePoolClients,
        spokeClientsEventSearchConfigs: Object.fromEntries(
          Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
        ),
      });
      return {
        valid: false,
        reason: "insufficient-dataworker-lookback",
      };
    }

    this.logger.debug({
      at: "Dataworker#validate",
      message: "Implied bundle ranges are valid",
      blockRangesImpliedByBundleEndBlocks,
      chainIdListForBundleEvaluationBlockNumbers: this.chainIdListForBundleEvaluationBlockNumbers,
    });

    // If config store version isn't up to date, return early. This is a simple rule that is perhaps too aggressive
    // but the proposer role is a specialized one and the user should always be using updated software.
    if (!this.clients.configStoreClient.hasLatestConfigStoreVersion) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Cannot validate because missing updated ConfigStore version. Update to latest code.",
        latestVersionSupported: this.clients.configStoreClient.configStoreVersion,
        latestInConfigStore: this.clients.configStoreClient.getConfigStoreVersionForTimestamp(),
      });
      return {
        valid: false,
        reason: "out-of-date-config-store-version",
      };
    }

    const mainnetBundleStartBlock = mainnetBlockRange[0];

    // Check if we have the right code to validate a bundle for the given block ranges.
    const versionAtProposalBlock =
      this.clients.configStoreClient.getConfigStoreVersionForBlock(mainnetBundleStartBlock);

    // Bundles that need to be validated with older code should emit helpful error logs about which code to run.
    // @dev only throw this error if the hub chain ID is 1, suggesting we're running on production.
    if (versionAtProposalBlock <= sdk.constants.TRANSFER_THRESHOLD_MAX_CONFIG_STORE_VERSION && hubPoolChainId === 1) {
      throw new Error(
        "Must use relayer-v2 code at commit 412ddc30af72c2ac78f9e4c8dccfccfd0eb478ab to validate a bundle with transferThreshold set"
      );
    }

    const logData = true;
    const rootBundleData = await this._proposeRootBundle(
      blockRangesImpliedByBundleEndBlocks,
      spokePoolClients,
      rootBundle.proposalBlockNumber,
      logData
    );

    const expectedPoolRebalanceRoot = {
      leaves: rootBundleData.poolRebalanceLeaves,
      tree: rootBundleData.poolRebalanceTree,
    };
    const expectedRelayerRefundRoot = {
      leaves: rootBundleData.relayerRefundLeaves,
      tree: rootBundleData.relayerRefundTree,
    };
    const expectedSlowRelayRoot = {
      leaves: rootBundleData.slowFillLeaves,
      tree: rootBundleData.slowFillTree,
    };
    const expectedTrees = {
      poolRebalanceTree: expectedPoolRebalanceRoot,
      relayerRefundTree: expectedRelayerRefundRoot,
      slowRelayTree: expectedSlowRelayRoot,
    };

    if (
      // Its ok if there are fewer unclaimed leaves than in the reconstructed root, because some of the leaves
      // might already have been executed, but its an issue if the reconstructed root expects fewer leaves than there
      // are left to execute because it means that the unclaimed count can never drop to 0.
      expectedPoolRebalanceRoot.leaves.length < rootBundle.unclaimedPoolRebalanceLeafCount ||
      expectedPoolRebalanceRoot.tree.getHexRoot() !== rootBundle.poolRebalanceRoot
    ) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected pool rebalance root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedPoolRebalanceLeaves: expectedPoolRebalanceRoot.leaves,
        expectedPoolRebalanceRoot: expectedPoolRebalanceRoot.tree.getHexRoot(),
        expectedRelayerRefundLeaves: expectedRelayerRefundRoot.leaves,
        expectedRelayerRefundRoot: expectedRelayerRefundRoot.tree.getHexRoot(),
        expectedSlowRelayLeaves: expectedSlowRelayRoot.leaves,
        expectedSlowRelayRoot: expectedSlowRelayRoot.tree.getHexRoot(),
        pendingRoot: rootBundle.poolRebalanceRoot,
        pendingPoolRebalanceLeafCount: rootBundle.unclaimedPoolRebalanceLeafCount,
      });
    } else if (expectedRelayerRefundRoot.tree.getHexRoot() !== rootBundle.relayerRefundRoot) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected relayer refund root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedRelayerRefundRoot: expectedRelayerRefundRoot.tree.getHexRoot(),
        pendingRoot: rootBundle.relayerRefundRoot,
      });
    } else if (expectedSlowRelayRoot.tree.getHexRoot() !== rootBundle.slowRelayRoot) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected slow relay root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedSlowRelayRoot: expectedSlowRelayRoot.tree.getHexRoot(),
        pendingRoot: rootBundle.slowRelayRoot,
      });
    } else {
      // All roots are valid! Exit early.
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Pending root bundle matches with expected",
      });
      return {
        valid: true,
        expectedTrees,
        reason: undefined,
      };
    }

    return {
      valid: false,
      reason:
        PoolRebalanceUtils.generateMarkdownForDispute(rootBundle) +
        "\n" +
        PoolRebalanceUtils.generateMarkdownForRootBundle(
          this.clients.hubPoolClient,
          this.chainIdListForBundleEvaluationBlockNumbers,
          hubPoolChainId,
          blockRangesImpliedByBundleEndBlocks,
          [...expectedPoolRebalanceRoot.leaves],
          expectedPoolRebalanceRoot.tree.getHexRoot(),
          [...expectedRelayerRefundRoot.leaves],
          expectedRelayerRefundRoot.tree.getHexRoot(),
          [...expectedSlowRelayRoot.leaves],
          expectedSlowRelayRoot.tree.getHexRoot()
        ),
      expectedTrees,
    };
  }

  // TODO: this method and executeRelayerRefundLeaves have a lot of similarities, but they have some key differences
  // in both the events they search for and the comparisons they make. We should try to generalize this in the future,
  // but keeping them separate is probably the simplest for the initial implementation.
  async executeSlowRelayLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients)),
    submitExecution = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<void> {
    this.logger.debug({
      at: "Dataworker#executeSlowRelayLeaves",
      message: "Executing slow relay leaves",
    });

    let latestRootBundles = sortEventsDescending(this.clients.hubPoolClient.getValidatedRootBundles());
    if (this.spokeRootsLookbackCount !== 0) {
      latestRootBundles = latestRootBundles.slice(0, this.spokeRootsLookbackCount);
    }

    await Promise.all(
      Object.entries(spokePoolClients).map(async ([_chainId, client]) => {
        const chainId = Number(_chainId);
        let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter(
          (rootBundle) => rootBundle.blockNumber >= client.eventSearchConfig.fromBlock
        );

        // Filter out roots that are not in the latest N root bundles. This assumes that
        // relayerRefundRoot+slowFillRoot combinations are unique.
        rootBundleRelays = this._getRelayedRootsFromBundles(latestRootBundles, rootBundleRelays);

        // Filter out empty slow fill roots:
        rootBundleRelays = rootBundleRelays.filter((rootBundle) => rootBundle.slowRelayRoot !== EMPTY_MERKLE_ROOT);

        this.logger.debug({
          at: "Dataworker#executeSlowRelayLeaves",
          message: `Evaluating ${rootBundleRelays.length} historical non-empty slow roots relayed to chain ${chainId}`,
        });

        const slowFillsForChain = client.getFills().filter(sdkUtils.isSlowFill);
        for (const rootBundleRelay of sortEventsAscending(rootBundleRelays)) {
          const matchingRootBundle = this.clients.hubPoolClient.getProposedRootBundles().find((bundle) => {
            if (bundle.slowRelayRoot !== rootBundleRelay.slowRelayRoot) {
              return false;
            }

            const followingBlockNumber =
              this.clients.hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber ||
              this.clients.hubPoolClient.latestBlockSearched;

            if (!followingBlockNumber) {
              return false;
            }

            const leaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);

            // Only use this bundle if it had valid leaves returned (meaning it was at least partially executed).
            return leaves.length > 0;
          });

          if (!matchingRootBundle) {
            this.logger.warn({
              at: "Dataworke#executeSlowRelayLeaves",
              message: "Couldn't find a matching mainnet root bundle for a slowRelayRoot on L2!",
              chainId,
              slowRelayRoot: rootBundleRelay.slowRelayRoot,
              rootBundleId: rootBundleRelay.rootBundleId,
            });
            continue;
          }

          const blockNumberRanges = getImpliedBundleBlockRanges(
            this.clients.hubPoolClient,
            this.clients.configStoreClient,
            matchingRootBundle
          );
          const mainnetBlockRange = getBlockRangeForChain(
            blockNumberRanges,
            this.clients.hubPoolClient.chainId,
            this.chainIdListForBundleEvaluationBlockNumbers
          );
          if (
            Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
            (await blockRangesAreInvalidForSpokeClients(
              spokePoolClients,
              blockNumberRanges,
              this.chainIdListForBundleEvaluationBlockNumbers,
              earliestBlocksInSpokePoolClients,
              this.isV3(mainnetBlockRange[0])
            ))
          ) {
            this.logger.warn({
              at: "Dataworke#executeSlowRelayLeaves",
              message:
                "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
              chainId,
              rootBundleRanges: blockNumberRanges,
              availableSpokePoolClients: Object.keys(spokePoolClients),
              earliestBlocksInSpokePoolClients,
              spokeClientsEventSearchConfigs: Object.fromEntries(
                Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
              ),
            });
            continue;
          }

          const rootBundleData = await this._proposeRootBundle(
            blockNumberRanges,
            spokePoolClients,
            matchingRootBundle.blockNumber
          );

          const { slowFillLeaves: leaves, slowFillTree: tree } = rootBundleData;
          if (tree.getHexRoot() !== rootBundleRelay.slowRelayRoot) {
            this.logger.warn({
              at: "Dataworke#executeSlowRelayLeaves",
              message: "Constructed a different root for the block range!",
              chainId,
              rootBundleRelay,
              mainnetRootBundleBlock: matchingRootBundle.blockNumber,
              mainnetRootBundleTxn: matchingRootBundle.transactionHash,
              publishedSlowRelayRoot: rootBundleRelay.slowRelayRoot,
              constructedSlowRelayRoot: tree.getHexRoot(),
            });
            continue;
          }

          const leavesForChain = leaves.filter((leaf) => sdkUtils.getSlowFillLeafChainId(leaf) === chainId);
          const unexecutedLeaves = leavesForChain.filter((leaf) => {
            const executedLeaf = slowFillsForChain.find(
              (event) =>
                event.originChainId === leaf.relayData.originChainId && event.depositId === leaf.relayData.depositId
            );

            // Only return true if no leaf was found in the list of executed leaves.
            return !executedLeaf;
          });
          if (unexecutedLeaves.length === 0) {
            continue;
          }

          await this._executeSlowFillLeaf(
            unexecutedLeaves,
            balanceAllocator,
            client,
            tree,
            submitExecution,
            rootBundleRelay.rootBundleId
          );
        }
      })
    );
  }

  async _executeSlowFillLeaf(
    _leaves: SlowFillLeaf[],
    balanceAllocator: BalanceAllocator,
    client: SpokePoolClient,
    slowRelayTree: MerkleTree<SlowFillLeaf>,
    submitExecution: boolean,
    rootBundleId?: number
  ): Promise<void> {
    // Ignore slow fill leaves for deposits with messages as these messages might be very expensive to execute.
    // The original depositor can always execute these and pay for the gas themselves.
    const leaves = _leaves.filter((leaf) => {
      const {
        relayData: { depositor, recipient, message },
      } = leaf;

      // If there is a message, we ignore the leaf and log an error.
      if (!sdk.utils.isMessageEmpty(message)) {
        const { method, args } = sdkUtils.isV2SlowFillLeaf(leaf)
          ? this.encodeV2SlowFillLeaf(slowRelayTree, rootBundleId, leaf)
          : this.encodeV3SlowFillLeaf(slowRelayTree, rootBundleId, leaf);

        this.logger.warn({
          at: "Dataworker#_executeSlowFillLeaf",
          message: "Ignoring slow fill leaf with message",
          method,
          args,
        });
        return false;
      }

      const ignoredAddresses = JSON.parse(process.env.IGNORED_ADDRESSES ?? "[]").map((address) =>
        ethersUtils.getAddress(address)
      );
      if (
        ignoredAddresses?.includes(ethersUtils.getAddress(depositor)) ||
        ignoredAddresses?.includes(ethersUtils.getAddress(recipient))
      ) {
        this.logger.warn({
          at: "Dataworker#_executeSlowFillLeaf",
          message: "Ignoring slow fill.",
          leafExecutionArgs: [depositor, recipient],
        });
        return false;
      }

      return true;
    });

    if (leaves.length === 0) {
      return;
    }

    const chainId = client.chainId;

    const sortedFills = client.getFills();
    const latestFills = leaves.map((slowFill) => {
      const { relayData } = slowFill;

      // Start with the most recent fills and search backwards.
      const fill = _.findLast(sortedFills, (fill) => {
        if (
          !(
            fill.depositId === relayData.depositId &&
            fill.originChainId === relayData.originChainId &&
            fill.destinationChainId === sdkUtils.getSlowFillLeafChainId(slowFill) &&
            fill.depositor === relayData.depositor &&
            fill.recipient === relayData.recipient &&
            (sdkUtils.isV3Fill(fill) && sdkUtils.isV3RelayData(relayData)
              ? fill.inputToken === relayData.inputToken
              : true) &&
            sdkUtils.getFillOutputToken(fill) === sdkUtils.getRelayDataOutputToken(relayData) &&
            sdkUtils.getFillOutputAmount(fill).eq(sdkUtils.getRelayDataOutputAmount(relayData)) &&
            fill.message === relayData.message
          )
        ) {
          return false;
        }

        if (sdkUtils.isV2Fill(fill) && sdkUtils.isV2RelayData(relayData)) {
          return fill.realizedLpFeePct.eq(relayData.realizedLpFeePct) && fill.relayerFeePct.eq(relayData.relayerFeePct);
        }

        if (sdkUtils.isV3Fill(fill) && sdkUtils.isV3RelayData(relayData)) {
          return (
            fill.fillDeadline === relayData.fillDeadline &&
            fill.exclusivityDeadline === relayData.exclusivityDeadline &&
            fill.exclusiveRelayer === relayData.exclusiveRelayer
          );
        }

        return false;
      });

      return fill;
    });

    // Filter for leaves where the contract has the funding to send the required tokens.
    const fundedLeaves = (
      await Promise.all(
        leaves.map(async (slowFill, idx) => {
          const destinationChainId = sdkUtils.getSlowFillLeafChainId(slowFill);
          if (destinationChainId !== chainId) {
            throw new Error(`Leaf chainId does not match input chainId (${destinationChainId} != ${chainId})`);
          }

          const outputAmount = sdkUtils.getRelayDataOutputAmount(slowFill.relayData);
          const fill = latestFills[idx];
          let amountRequired: BigNumber;
          if (sdkUtils.isV3SlowFillLeaf<V3SlowFillLeaf, V2SlowFillLeaf>(slowFill)) {
            amountRequired = isDefined(fill) ? bnZero : slowFill.updatedOutputAmount;
          } else {
            // If the most recent fill is not found, just make the most conservative assumption: a 0-sized fill.
            const totalFilledAmount = isDefined(fill) ? sdkUtils.getTotalFilledAmount(fill) : bnZero;

            // Note: the getRefund function just happens to perform the same math we need.
            // A refund is the total fill amount minus LP fees, which is the same as the payout for a slow relay!
            amountRequired = getRefund(outputAmount.sub(totalFilledAmount), slowFill.relayData.realizedLpFeePct);
          }

          // If the fill has been completed there's no need to execute the slow fill leaf.
          if (amountRequired.eq(bnZero)) {
            return undefined;
          }

          const outputToken = sdkUtils.getRelayDataOutputToken(slowFill.relayData);
          const success = await balanceAllocator.requestBalanceAllocation(
            destinationChainId,
            l2TokensToCountTowardsSpokePoolLeafExecutionCapital(outputToken, destinationChainId),
            client.spokePool.address,
            amountRequired
          );

          if (!success) {
            this.logger.warn({
              at: "Dataworker#executeSlowRelayLeaves",
              message: "Not executing slow relay leaf due to lack of funds in SpokePool",
              root: slowRelayTree.getHexRoot(),
              bundle: rootBundleId,
              depositId: slowFill.relayData.depositId,
              fromChain: slowFill.relayData.originChainId,
              chainId: destinationChainId,
              token: outputToken,
              amount: outputAmount,
            });
          }

          // Assume we don't need to add balance in the BalanceAllocator to the HubPool because the slow fill's
          // recipient wouldn't be the HubPool in normal circumstances.
          return success ? slowFill : undefined;
        })
      )
    ).filter(isDefined);

    const hubChainId = this.clients.hubPoolClient.chainId;
    fundedLeaves.forEach((leaf) => {
      assert(sdkUtils.getSlowFillLeafChainId(leaf) === chainId);

      const { relayData } = leaf;
      const outputAmount = sdkUtils.getRelayDataOutputAmount(relayData);
      const mrkdwn =
        `rootBundleId: ${rootBundleId}\n` +
        `slowRelayRoot: ${slowRelayTree.getHexRoot()}\n` +
        `Origin chain: ${relayData.originChainId}\n` +
        `Destination chain:${chainId}\n` +
        `Deposit Id: ${relayData.depositId}\n` +
        `amount: ${outputAmount.toString()}`;

      if (submitExecution) {
        const { method, args } = sdkUtils.isV2SlowFillLeaf(leaf)
          ? this.encodeV2SlowFillLeaf(slowRelayTree, rootBundleId, leaf)
          : this.encodeV3SlowFillLeaf(slowRelayTree, rootBundleId, leaf);

        this.clients.multiCallerClient.enqueueTransaction({
          contract: client.spokePool,
          chainId,
          method,
          args,
          message: "Executed SlowRelayLeaf 🌿!",
          mrkdwn,
          // If mainnet, send through Multicall3 so it can be batched with PoolRebalanceLeaf executions, otherwise
          // SpokePool.multicall() is fine.
          unpermissioned: chainId === hubChainId,
          // If simulating mainnet execution, can fail as it may require funds to be sent from
          // pool rebalance leaf.
          canFailInSimulation: chainId === hubChainId,
        });
      } else {
        this.logger.debug({ at: "Dataworker#executeSlowRelayLeaves", message: mrkdwn });
      }
    });
  }

  encodeV2SlowFillLeaf(
    slowRelayTree: MerkleTree<SlowFillLeaf>,
    rootBundleId: number,
    leaf: V2SlowFillLeaf
  ): { method: string; args: (number | BigNumber | string | string[])[] } {
    const { relayData, payoutAdjustmentPct } = leaf;

    const method = "executeSlowRelayLeaf";
    const proof = slowRelayTree.getHexProof({ relayData, payoutAdjustmentPct });
    const args = [
      relayData.depositor,
      relayData.recipient,
      relayData.destinationToken,
      relayData.amount,
      relayData.originChainId,
      relayData.realizedLpFeePct,
      relayData.relayerFeePct,
      relayData.depositId,
      rootBundleId,
      relayData.message,
      leaf.payoutAdjustmentPct,
      proof,
    ];

    return { method, args };
  }

  encodeV3SlowFillLeaf(
    slowRelayTree: MerkleTree<SlowFillLeaf>,
    rootBundleId: number,
    leaf: V3SlowFillLeaf
  ): { method: string; args: (number | string[] | V3SlowFillLeaf)[] } {
    const { relayData, chainId, updatedOutputAmount } = leaf;

    const method = "executeV3SlowRelayLeaf";
    const proof = slowRelayTree.getHexProof({ relayData, chainId, updatedOutputAmount });
    const args = [leaf, rootBundleId, proof];

    return { method, args };
  }

  async executePoolRebalanceLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients)),
    submitExecution = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<void> {
    this.logger.debug({
      at: "Dataworker#executePoolRebalanceLeaves",
      message: "Executing pool rebalance leaves",
    });

    if (!this.clients.hubPoolClient.isUpdated || this.clients.hubPoolClient.currentTime === undefined) {
      throw new Error("HubPoolClient not updated");
    }
    const hubPoolChainId = this.clients.hubPoolClient.chainId;

    // Exit early if a bundle is not pending.
    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundle();
    if (pendingRootBundle === undefined) {
      this.logger.debug({
        at: "Dataworker#executePoolRebalanceLeaves",
        message: "No pending proposal, nothing to execute",
      });
      return;
    }

    this.logger.debug({
      at: "Dataworker#executePoolRebalanceLeaves",
      message: "Found pending proposal",
      pendingRootBundle,
    });

    const nextBundleMainnetStartBlock = this.clients.hubPoolClient.getNextBundleStartBlockNumber(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.clients.hubPoolClient.latestBlockSearched,
      this.clients.hubPoolClient.chainId
    );
    const widestPossibleExpectedBlockRange = this._getWidestPossibleBlockRangeForNextBundle(
      spokePoolClients,
      nextBundleMainnetStartBlock
    );
    const { valid, reason, expectedTrees } = await this.validateRootBundle(
      hubPoolChainId,
      widestPossibleExpectedBlockRange,
      pendingRootBundle,
      spokePoolClients,
      earliestBlocksInSpokePoolClients
    );

    if (!valid) {
      this.logger.error({
        at: "Dataworker#executePoolRebalanceLeaves",
        message: "Found invalid proposal after challenge period!",
        reason,
        e: reason,
        notificationPath: "across-error",
      });
      return;
    }

    if (valid && !expectedTrees) {
      this.logger.error({
        at: "Dataworker#executePoolRebalanceLeaves",
        message:
          "Found valid proposal, but no trees could be generated. This probably means that the proposal was never evaluated during liveness due to an odd block range!",
        reason,
        notificationPath: "across-error",
      });
      return;
    }

    // Call `exchangeRateCurrent` on the HubPool before accumulating fees from the executed bundle leaves and before
    // exiting early if challenge period isn't passed. This ensures that there is a maximum amount of time between
    // exchangeRateCurrent calls and that these happen before pool leaves are executed. This is to
    // address the situation where `addLiquidity` and `removeLiquidity` have not been called for an L1 token for a
    // while, which are the other methods that trigger an internal call to `_exchangeRateCurrent()`. Calling
    // this method triggers a recompounding of fees before new fees come in.
    const l1TokensInBundle = expectedTrees.poolRebalanceTree.leaves.reduce((l1TokenSet, leaf) => {
      const currLeafL1Tokens = leaf.l1Tokens;
      currLeafL1Tokens.forEach((l1Token) => {
        if (!l1TokenSet.includes(l1Token)) {
          l1TokenSet.push(l1Token);
        }
      });
      return l1TokenSet;
    }, []);
    await this._updateExchangeRates(l1TokensInBundle, submitExecution);

    // Exit early if challenge period timestamp has not passed:
    if (this.clients.hubPoolClient.currentTime <= pendingRootBundle.challengePeriodEndTimestamp) {
      this.logger.debug({
        at: "Dataworker#executePoolRebalanceLeaves",
        message: `Challenge period not passed, cannot execute until ${pendingRootBundle.challengePeriodEndTimestamp}`,
        expirationTime: pendingRootBundle.challengePeriodEndTimestamp,
      });
      return;
    }

    const executedLeaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(
      this.clients.hubPoolClient.getLatestProposedRootBundle(),
      this.clients.hubPoolClient.latestBlockSearched
    );

    // Filter out previously executed leaves.
    const unexecutedLeaves = expectedTrees.poolRebalanceTree.leaves.filter((leaf) =>
      executedLeaves.every(({ leafId }) => leafId !== leaf.leafId)
    );
    if (unexecutedLeaves.length === 0) {
      return;
    }

    // First, execute mainnet pool rebalance leaves. Then try to execute any relayer refund and slow leaves for the
    // expected relayed root hash, then proceed with remaining pool rebalance leaves. This is an optimization that
    // takes advantage of the fact that mainnet transfers between HubPool and SpokePool are atomic.
    const mainnetLeaves = unexecutedLeaves.filter((leaf) => leaf.chainId === hubPoolChainId);
    if (mainnetLeaves.length > 0) {
      await this._executePoolRebalanceLeaves(
        spokePoolClients,
        mainnetLeaves,
        balanceAllocator,
        expectedTrees.poolRebalanceTree.tree,
        submitExecution
      );

      // We need to know the next root bundle ID for the mainnet spoke pool in order to execute leaves for roots that
      // will be relayed after executing the above pool rebalance root.
      const nextRootBundleIdForMainnet = spokePoolClients[hubPoolChainId].getLatestRootBundleId();

      // Now, execute refund and slow fill leaves for Mainnet using new funds. These methods will return early if there
      // are no relevant leaves to execute.
      await this._executeSlowFillLeaf(
        expectedTrees.slowRelayTree.leaves.filter((leaf) => sdkUtils.getSlowFillLeafChainId(leaf) === hubPoolChainId),
        balanceAllocator,
        spokePoolClients[hubPoolChainId],
        expectedTrees.slowRelayTree.tree,
        submitExecution,
        nextRootBundleIdForMainnet
      );
      await this._executeRelayerRefundLeaves(
        expectedTrees.relayerRefundTree.leaves.filter((leaf) => leaf.chainId === hubPoolChainId),
        balanceAllocator,
        spokePoolClients[hubPoolChainId],
        expectedTrees.relayerRefundTree.tree,
        submitExecution,
        nextRootBundleIdForMainnet
      );
    }

    // Perform similar funding checks for remaining non-mainnet pool rebalance leaves.
    await this._executePoolRebalanceLeaves(
      spokePoolClients,
      unexecutedLeaves.filter((leaf) => leaf.chainId !== hubPoolChainId),
      balanceAllocator,
      expectedTrees.poolRebalanceTree.tree,
      submitExecution
    );
  }

  async _executePoolRebalanceLeaves(
    spokePoolClients: {
      [chainId: number]: SpokePoolClient;
    },
    leaves: PoolRebalanceLeaf[],
    balanceAllocator: BalanceAllocator,
    tree: MerkleTree<PoolRebalanceLeaf>,
    submitExecution: boolean
  ): Promise<void> {
    const hubPoolChainId = this.clients.hubPoolClient.chainId;
    const fundedLeaves = (
      await Promise.all(
        leaves.map(async (leaf) => {
          const requests = leaf.netSendAmounts.map((amount, i) => ({
            amount: amount.gt(bnZero) ? amount : bnZero,
            tokens: [leaf.l1Tokens[i]],
            holder: this.clients.hubPoolClient.hubPool.address,
            chainId: hubPoolChainId,
          }));

          if (sdkUtils.chainIsArbitrum(leaf.chainId)) {
            const hubPoolBalance = await this.clients.hubPoolClient.hubPool.provider.getBalance(
              this.clients.hubPoolClient.hubPool.address
            );
            if (hubPoolBalance.lt(this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf))) {
              requests.push({
                tokens: [ZERO_ADDRESS],
                amount: this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf),
                holder: await this.clients.hubPoolClient.hubPool.signer.getAddress(),
                chainId: hubPoolChainId,
              });
            }
          }

          const success = await balanceAllocator.requestBalanceAllocations(
            requests.filter((req) => req.amount.gt(bnZero))
          );

          if (!success) {
            // Note: this is an error because the HubPool should generally not run out of funds to put into
            // netSendAmounts. This means that no new bundles can be proposed until this leaf is funded.
            this.logger.error({
              at: "Dataworker#executePoolRebalanceLeaves",
              message: "Not executing pool rebalance leaf on HubPool due to lack of funds to send.",
              root: tree.getHexRoot(),
              leafId: leaf.leafId,
              rebalanceChain: leaf.chainId,
              chainId: hubPoolChainId,
              token: leaf.l1Tokens,
              netSendAmounts: leaf.netSendAmounts,
            });
          } else {
            // Add balances to spoke pool on mainnet since we know it will be sent atomically.
            if (leaf.chainId === hubPoolChainId) {
              await Promise.all(
                leaf.netSendAmounts.map(async (amount, i) => {
                  if (amount.gt(bnZero)) {
                    await balanceAllocator.addUsed(
                      leaf.chainId,
                      leaf.l1Tokens[i],
                      spokePoolClients[leaf.chainId].spokePool.address,
                      amount.mul(-1)
                    );
                  }
                })
              );
            }
          }
          return success ? leaf : undefined;
        })
      )
    ).filter(isDefined);

    let hubPoolBalance;
    if (fundedLeaves.some((leaf) => sdkUtils.chainIsArbitrum(leaf.chainId))) {
      hubPoolBalance = await this.clients.hubPoolClient.hubPool.provider.getBalance(
        this.clients.hubPoolClient.hubPool.address
      );
    }
    fundedLeaves.forEach((leaf) => {
      const proof = tree.getHexProof(leaf);
      const mrkdwn = `Root hash: ${tree.getHexRoot()}\nLeaf: ${leaf.leafId}\nChain: ${leaf.chainId}`;
      if (submitExecution) {
        if (sdkUtils.chainIsArbitrum(leaf.chainId)) {
          if (hubPoolBalance.lt(this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf))) {
            this.clients.multiCallerClient.enqueueTransaction({
              contract: this.clients.hubPoolClient.hubPool,
              chainId: hubPoolChainId,
              method: "loadEthForL2Calls",
              args: [],
              message: `Loaded ETH for message to ${getNetworkName(leaf.chainId)} 📨!`,
              mrkdwn,
              value: this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf),
            });
          }
        }
        this.clients.multiCallerClient.enqueueTransaction({
          contract: this.clients.hubPoolClient.hubPool,
          chainId: hubPoolChainId,
          method: "executeRootBundle",
          args: [
            leaf.chainId,
            leaf.groupIndex,
            leaf.bundleLpFees,
            leaf.netSendAmounts,
            leaf.runningBalances,
            leaf.leafId,
            leaf.l1Tokens,
            proof,
          ],
          message: "Executed PoolRebalanceLeaf 🌿!",
          mrkdwn,
          unpermissioned: true,
          // If simulating execution of leaves for non-mainnet chains, can fail as it may require funds to be returned
          // from relayer refund leaves.
          canFailInSimulation: leaf.chainId !== hubPoolChainId,
        });
      } else {
        this.logger.debug({ at: "Dataworker#executePoolRebalanceLeaves", message: mrkdwn });
      }
    });
  }

  async _updateExchangeRates(l1Tokens: string[], submitExecution: boolean): Promise<void> {
    const syncedL1Tokens: string[] = [];
    await sdk.utils.forEachAsync(l1Tokens, async (l1Token) => {
      // Exit early if we already synced this l1 token on this loop
      if (syncedL1Tokens.includes(l1Token)) {
        return;
      } else {
        syncedL1Tokens.push(l1Token);
      }

      // Exit early if we recently synced this token.
      const lastestFeesCompoundedTime =
        this.clients.hubPoolClient.getLpTokenInfoForL1Token(l1Token)?.lastLpFeeUpdate ?? 0;
      if (
        this.clients.hubPoolClient.currentTime === undefined ||
        this.clients.hubPoolClient.currentTime - lastestFeesCompoundedTime <= 7200 // 2 hours
      ) {
        return;
      }

      // Check how liquidReserves will be affected by the exchange rate update and skip it if it wouldn't increase.
      // Updating exchange rate current or sync-ing pooled tokens is used only to potentially increase liquid
      // reserves available to the HubPool to execute pool rebalance leaves, particularly fot tokens that haven't
      // updated recently. If the liquid reserves would not increase, then we skip the update.
      const hubPool = this.clients.hubPoolClient.hubPool;
      const multicallInput = [
        hubPool.interface.encodeFunctionData("pooledTokens", [l1Token]),
        hubPool.interface.encodeFunctionData("sync", [l1Token]),
        hubPool.interface.encodeFunctionData("pooledTokens", [l1Token]),
      ];
      const multicallOutput = await hubPool.callStatic.multicall(multicallInput);
      const currentPooledTokens = hubPool.interface.decodeFunctionResult("pooledTokens", multicallOutput[0]);
      const updatedPooledTokens = hubPool.interface.decodeFunctionResult("pooledTokens", multicallOutput[2]);
      const liquidReservesDelta = updatedPooledTokens.liquidReserves.sub(currentPooledTokens.liquidReserves);

      // If the delta is positive, then the update will increase liquid reserves and
      // at this point, we want to update the liquid reserves to make more available
      // for executing a pool rebalance leaf.
      const chainId = this.clients.hubPoolClient.chainId;
      const tokenSymbol = this.clients.hubPoolClient.getTokenInfo(chainId, l1Token)?.symbol;

      if (liquidReservesDelta.lte(0)) {
        this.logger.debug({
          at: "Dataworker#_updateExchangeRates",
          message: `Skipping exchange rate update for ${tokenSymbol} because liquid reserves would not increase`,
          currentPooledTokens,
          updatedPooledTokens,
          liquidReservesDelta,
        });
        return;
      }

      if (submitExecution) {
        this.clients.multiCallerClient.enqueueTransaction({
          contract: hubPool,
          chainId,
          method: "exchangeRateCurrent",
          args: [l1Token],
          message: "Updated exchange rate ♻️!",
          mrkdwn: `Updated exchange rate for l1 token: ${tokenSymbol}`,
          unpermissioned: true,
        });
      }
    });
  }

  async executeRelayerRefundLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients)),
    submitExecution = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<void> {
    const { configStoreClient, hubPoolClient } = this.clients;
    this.logger.debug({ at: "Dataworker#executeRelayerRefundLeaves", message: "Executing relayer refund leaves" });

    let latestRootBundles = sortEventsDescending(hubPoolClient.getValidatedRootBundles());
    if (this.spokeRootsLookbackCount !== 0) {
      latestRootBundles = latestRootBundles.slice(0, this.spokeRootsLookbackCount);
    }

    // Execute each chain's leaves sequentially to take advantage of pool rebalance root caching. If we executed
    // each chain in parallel, then we'd have to reconstruct identical pool rebalance root more times than necessary.
    for (const [_chainId, client] of Object.entries(spokePoolClients)) {
      const chainId = Number(_chainId);
      let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter(
        (rootBundle) => rootBundle.blockNumber >= client.eventSearchConfig.fromBlock
      );

      // Filter out roots that are not in the latest N root bundles. This assumes that
      // relayerRefundRoot+slowFillRoot combinations are unique.
      rootBundleRelays = this._getRelayedRootsFromBundles(latestRootBundles, rootBundleRelays);

      // Filter out empty relayer refund root:
      rootBundleRelays = rootBundleRelays.filter((rootBundle) => rootBundle.relayerRefundRoot !== EMPTY_MERKLE_ROOT);

      this.logger.debug({
        at: "Dataworker#executeRelayerRefundLeaves",
        message: `Evaluating ${rootBundleRelays.length} historical non-empty relayer refund root bundles on chain ${chainId}`,
      });

      const executedLeavesForChain = client.getRelayerRefundExecutions();

      for (const rootBundleRelay of sortEventsAscending(rootBundleRelays)) {
        const matchingRootBundle = hubPoolClient.getProposedRootBundles().find((bundle) => {
          if (bundle.relayerRefundRoot !== rootBundleRelay.relayerRefundRoot) {
            return false;
          }
          const followingBlockNumber =
            hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber || hubPoolClient.latestBlockSearched;

          if (followingBlockNumber === undefined) {
            return false;
          }

          const leaves = hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);

          // Only use this bundle if it had valid leaves returned (meaning it was at least partially executed).
          return leaves.length > 0;
        });

        if (!matchingRootBundle) {
          this.logger.warn({
            at: "Dataworke#executeRelayerRefundLeaves",
            message: "Couldn't find a matching mainnet root bundle for a relayerRefundRoot on L2!",
            chainId,
            relayerRefundRoot: rootBundleRelay.relayerRefundRoot,
            rootBundleId: rootBundleRelay.rootBundleId,
          });
          continue;
        }

        const blockNumberRanges = getImpliedBundleBlockRanges(hubPoolClient, configStoreClient, matchingRootBundle);
        const mainnetBlockRanges = getBlockRangeForChain(
          blockNumberRanges,
          hubPoolClient.chainId,
          this.chainIdListForBundleEvaluationBlockNumbers
        );
        if (
          Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
          (await blockRangesAreInvalidForSpokeClients(
            spokePoolClients,
            blockNumberRanges,
            this.chainIdListForBundleEvaluationBlockNumbers,
            earliestBlocksInSpokePoolClients,
            this.isV3(mainnetBlockRanges[0])
          ))
        ) {
          this.logger.warn({
            at: "Dataworke#executeRelayerRefundLeaves",
            message: "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
            chainId,
            rootBundleRanges: blockNumberRanges,
            availableSpokePoolClients: Object.keys(spokePoolClients),
            earliestBlocksInSpokePoolClients,
            spokeClientsEventSearchConfigs: Object.fromEntries(
              Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
            ),
          });
          continue;
        }

        const { relayerRefundLeaves: leaves, relayerRefundTree: tree } = await this._proposeRootBundle(
          blockNumberRanges,
          spokePoolClients,
          matchingRootBundle.blockNumber
        );

        if (tree.getHexRoot() !== rootBundleRelay.relayerRefundRoot) {
          this.logger.warn({
            at: "Dataworke#executeRelayerRefundLeaves",
            message: "Constructed a different root for the block range!",
            chainId,
            rootBundleRelay,
            mainnetRootBundleBlock: matchingRootBundle.blockNumber,
            mainnetRootBundleTxn: matchingRootBundle.transactionHash,
            publishedRelayerRefundRoot: rootBundleRelay.relayerRefundRoot,
            constructedRelayerRefundRoot: tree.getHexRoot(),
          });
          continue;
        }

        const leavesForChain = leaves.filter((leaf) => leaf.chainId === Number(chainId));
        const unexecutedLeaves = leavesForChain.filter((leaf) => {
          const executedLeaf = executedLeavesForChain.find(
            (event) => event.rootBundleId === rootBundleRelay.rootBundleId && event.leafId === leaf.leafId
          );
          // Only return true if no leaf was found in the list of executed leaves.
          return !executedLeaf;
        });
        if (unexecutedLeaves.length === 0) {
          continue;
        }

        await this._executeRelayerRefundLeaves(
          unexecutedLeaves,
          balanceAllocator,
          client,
          tree,
          submitExecution,
          rootBundleRelay.rootBundleId
        );
      }
    }
  }

  async _executeRelayerRefundLeaves(
    leaves: RelayerRefundLeaf[],
    balanceAllocator: BalanceAllocator,
    client: SpokePoolClient,
    relayerRefundTree: MerkleTree<RelayerRefundLeaf>,
    submitExecution: boolean,
    rootBundleId: number
  ): Promise<void> {
    if (leaves.length === 0) {
      return;
    }
    const chainId = client.chainId;
    // Filter for leaves where the contract has the funding to send the required tokens.
    const fundedLeaves = (
      await Promise.all(
        leaves.map(async (leaf) => {
          if (leaf.chainId !== chainId) {
            throw new Error("Leaf chainId does not match input chainId");
          }
          const l1TokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(leaf.l2TokenAddress, chainId);
          const refundSum = leaf.refundAmounts.reduce((acc, curr) => acc.add(curr), BigNumber.from(0));
          const totalSent = refundSum.add(leaf.amountToReturn.gte(0) ? leaf.amountToReturn : BigNumber.from(0));
          const success = await balanceAllocator.requestBalanceAllocation(
            leaf.chainId,
            l2TokensToCountTowardsSpokePoolLeafExecutionCapital(leaf.l2TokenAddress, leaf.chainId),
            client.spokePool.address,
            totalSent
          );

          if (!success) {
            this.logger.warn({
              at: "Dataworker#executeRelayerRefundLeaves",
              message: "Not executing relayer refund leaf on SpokePool due to lack of funds.",
              root: relayerRefundTree.getHexRoot(),
              bundle: rootBundleId,
              leafId: leaf.leafId,
              token: l1TokenInfo?.symbol,
              chainId: leaf.chainId,
              amountToReturn: leaf.amountToReturn,
              refunds: leaf.refundAmounts,
            });
          } else {
            // If mainnet leaf, then allocate balance to the HubPool since it will be atomically transferred.
            if (leaf.chainId === this.clients.hubPoolClient.chainId && leaf.amountToReturn.gt(0)) {
              await balanceAllocator.addUsed(
                leaf.chainId,
                leaf.l2TokenAddress,
                this.clients.hubPoolClient.hubPool.address,
                leaf.amountToReturn.mul(-1)
              );
            }
          }

          return success ? leaf : undefined;
        })
      )
    ).filter(isDefined);

    fundedLeaves.forEach((leaf) => {
      const l1TokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(leaf.l2TokenAddress, chainId);

      const mrkdwn = `rootBundleId: ${rootBundleId}\nrelayerRefundRoot: ${relayerRefundTree.getHexRoot()}\nLeaf: ${
        leaf.leafId
      }\nchainId: ${chainId}\ntoken: ${l1TokenInfo?.symbol}\namount: ${leaf.amountToReturn.toString()}`;
      if (submitExecution) {
        this.clients.multiCallerClient.enqueueTransaction({
          contract: client.spokePool,
          chainId: Number(chainId),
          method: "executeRelayerRefundLeaf",
          args: [rootBundleId, leaf, relayerRefundTree.getHexProof(leaf)],
          message: "Executed RelayerRefundLeaf 🌿!",
          mrkdwn,
          // If mainnet, send through Multicall3 so it can be batched with PoolRebalanceLeaf executions, otherwise
          // SpokePool.multicall() is fine.
          unpermissioned: Number(chainId) === 1,
          // If simulating mainnet execution, can fail as it may require funds to be sent from
          // pool rebalance leaf.
          canFailInSimulation: leaf.chainId === this.clients.hubPoolClient.chainId,
        });
      } else {
        this.logger.debug({ at: "Dataworker#executeRelayerRefundLeaves", message: mrkdwn });
      }
    });
  }

  enqueueRootBundleProposal(
    hubPoolChainId: number,
    bundleBlockRange: number[][],
    poolRebalanceLeaves: PoolRebalanceLeaf[],
    poolRebalanceRoot: string,
    relayerRefundLeaves: RelayerRefundLeaf[],
    relayerRefundRoot: string,
    slowRelayLeaves: SlowFillLeaf[],
    slowRelayRoot: string
  ): void {
    try {
      const bundleEndBlocks = bundleBlockRange.map((block) => block[1]);
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.hubPoolClient.hubPool, // target contract
        chainId: hubPoolChainId,
        method: "proposeRootBundle", // method called.
        args: [bundleEndBlocks, poolRebalanceLeaves.length, poolRebalanceRoot, relayerRefundRoot, slowRelayRoot], // props sent with function call.
        message: "Proposed new root bundle 🌱", // message sent to logger.
        mrkdwn: PoolRebalanceUtils.generateMarkdownForRootBundle(
          this.clients.hubPoolClient,
          this.chainIdListForBundleEvaluationBlockNumbers,
          hubPoolChainId,
          bundleBlockRange,
          [...poolRebalanceLeaves],
          poolRebalanceRoot,
          [...relayerRefundLeaves],
          relayerRefundRoot,
          [...slowRelayLeaves],
          slowRelayRoot
        ),
      });
    } catch (error) {
      this.logger.error({
        at: "Dataworker",
        message: "Error creating proposeRootBundleTx",
        error,
        notificationPath: "across-error",
      });
    }
  }

  _submitDisputeWithMrkdwn(hubPoolChainId: number, mrkdwn: string): void {
    try {
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.hubPoolClient.hubPool, // target contract
        chainId: hubPoolChainId,
        method: "disputeRootBundle", // method called.
        args: [], // props sent with function call.
        message: "Disputed pending root bundle 👺", // message sent to logger.
        mrkdwn,
      });
    } catch (error) {
      this.logger.error({
        at: "Dataworker",
        message: "Error creating disputeRootBundleTx",
        error,
        notificationPath: "across-error",
      });
    }
  }

  async _getPoolRebalanceRoot(
    spokePoolClients: SpokePoolClientsByChain,
    blockRangesForChains: number[][],
    latestMainnetBlock: number,
    mainnetBundleEndBlock: number,
    fillsToRefund: FillsToRefund,
    deposits: V2DepositWithBlock[],
    allValidFills: V2FillWithBlock[],
    allValidFillsInRange: V2FillWithBlock[],
    unfilledDeposits: UnfilledDeposit[],
    earlyDeposits: sdk.typechain.FundsDepositedEvent[],
    bundleV3Deposits: BundleDepositsV3,
    bundleV3Fills: BundleFillsV3,
    bundleSlowFills: BundleSlowFills,
    unexecutableSlowFills: BundleExcessSlowFills,
    expiredDepositsToRefundV3: ExpiredDepositsToRefundV3,
    logSlowFillExcessData = false
  ): Promise<PoolRebalanceRoot> {
    const key = JSON.stringify(blockRangesForChains);
    // FIXME: Temporary fix to disable root cache rebalancing and to keep the
    //        executor running for tonight (2023-08-28) until we can fix the
    //        root cache rebalancing bug.
    if (!this.rootCache[key] || process.env.DATAWORKER_DISABLE_REBALANCE_ROOT_CACHE === "true") {
      this.rootCache[key] = await _buildPoolRebalanceRoot(
        latestMainnetBlock,
        mainnetBundleEndBlock,
        fillsToRefund,
        deposits,
        allValidFills,
        allValidFillsInRange,
        unfilledDeposits,
        earlyDeposits,
        bundleV3Deposits,
        bundleV3Fills,
        bundleSlowFills,
        unexecutableSlowFills,
        expiredDepositsToRefundV3,
        this.clients,
        spokePoolClients,
        this.maxL1TokenCountOverride,
        logSlowFillExcessData ? this.logger : undefined
      );
    }

    return _.cloneDeep(this.rootCache[key]);
  }

  _getRequiredEthForArbitrumPoolRebalanceLeaf(leaf: PoolRebalanceLeaf): BigNumber {
    // For arbitrum, the bot needs enough ETH to pay for each L1 -> L2 message.
    // The following executions trigger an L1 -> L2 message:
    // 1. The first arbitrum leaf for a particular set of roots. This means the roots must be sent and is
    //    signified by groupIndex === 0.
    // 2. Any netSendAmount > 0 triggers an L1 -> L2 token send, which costs 0.02 ETH.
    let requiredAmount = leaf.netSendAmounts.reduce(
      (acc, curr) => (curr.gt(0) ? acc.add(toBNWei("0.02")) : acc),
      BigNumber.from(0)
    );

    if (leaf.groupIndex === 0) {
      requiredAmount = requiredAmount.add(toBNWei("0.02"));
    }
    return requiredAmount;
  }

  /**
   * Filters out any root bundles that don't have a matching relayerRefundRoot+slowRelayRoot combination in the
   * list of proposed root bundles `allRootBundleRelays`.
   * @param targetRootBundles Root bundles whose relayed roots we want to find
   * @param allRootBundleRelays All relayed roots to search
   * @returns Relayed roots that originated from rootBundles contained in allRootBundleRelays
   */
  _getRelayedRootsFromBundles(
    targetRootBundles: ProposedRootBundle[],
    allRootBundleRelays: RootBundleRelayWithBlock[]
  ): RootBundleRelayWithBlock[] {
    return allRootBundleRelays.filter((rootBundle) =>
      targetRootBundles.some(
        (_rootBundle) =>
          _rootBundle.relayerRefundRoot === rootBundle.relayerRefundRoot &&
          _rootBundle.slowRelayRoot === rootBundle.slowRelayRoot
      )
    );
  }

  /**
   * Returns widest possible block range for next bundle.
   * @param spokePoolClients SpokePool clients to query. If one is undefined then the chain ID will be treated as
   * disabled.
   * @param mainnetBundleStartBlock Passed in to determine which disabled chain list to use (i.e. the list that is live
   * at the time of this block). Also used to determine which chain ID indices list to use which is the max
   * set of chains we can return block ranges for.
   * @returns [number, number]: [startBlock, endBlock]
   */
  _getWidestPossibleBlockRangeForNextBundle(
    spokePoolClients: SpokePoolClientsByChain,
    mainnetBundleStartBlock: number
  ): number[][] {
    return PoolRebalanceUtils.getWidestPossibleExpectedBlockRange(
      // We only want as many block ranges as there are chains enabled at the time of the bundle start block.
      this.clients.configStoreClient.getChainIdIndicesForBlock(mainnetBundleStartBlock),
      spokePoolClients,
      getEndBlockBuffers(this.chainIdListForBundleEvaluationBlockNumbers, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockSearched,
      // We only want to count enabled chains at the same time that we are loading chain ID indices.
      this.clients.configStoreClient.getEnabledChains(mainnetBundleStartBlock)
    );
  }
}
