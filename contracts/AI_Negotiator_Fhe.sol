pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AINegotiatorFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Negotiation {
        euint32 targetPrice;
        euint32 bottomLine;
    }
    mapping(uint256 => mapping(address => Negotiation)) public batchNegotiations;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsChanged(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event NegotiationSubmitted(address indexed user, uint256 indexed batchId, bytes32 targetPriceCt, bytes32 bottomLineCt);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 targetPrice, uint32 bottomLine);

    error NotOwner();
    error NotProvider();
    error PausedContract();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidBatchId();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedContract();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        currentBatchId = 1; // Start with batch 1
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert PausedContract(); // Revert if already unpaused
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        emit CooldownSecondsChanged(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        // New batch is open by default, no need to set isBatchClosed[currentBatchId] = false explicitly
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatchId();
        isBatchClosed[batchId] = true;
        emit BatchClosed(batchId);
    }

    function submitNegotiation(
        uint256 batchId,
        bytes32 targetPriceCt,
        bytes32 bottomLineCt
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchId == 0 || batchId > currentBatchId || isBatchClosed[batchId]) {
            revert BatchClosedOrInvalid();
        }

        euint32 memory targetPrice = FHE.asEuint32(targetPriceCt);
        euint32 memory bottomLine = FHE.asEuint32(bottomLineCt);

        // Basic initialization check for demonstration
        _initIfNeeded(targetPrice);
        _initIfNeeded(bottomLine);

        batchNegotiations[batchId][msg.sender] = Negotiation(targetPrice, bottomLine);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit NegotiationSubmitted(msg.sender, batchId, targetPriceCt, bottomLineCt);
    }

    function requestDecryptionForBatch(uint256 batchId) external onlyProvider whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatchId();
        if (!isBatchClosed[batchId]) revert BatchClosedOrInvalid(); // Must be closed to process

        // 1. Prepare Ciphertexts
        // For this example, we'll sum all target prices and bottom lines in the batch.
        // This is a simplified aggregation; a real AI would be more complex.
        euint32 memory sumTargetPrices;
        euint32 memory sumBottomLines;
        bool initializedSums = false;

        address currentProvider = address(uint160(batchNegotiations[batchId].slot)); // Start iteration from first slot
        while (currentProvider != address(0)) { // Iterate through providers in the batch
            Negotiation storage neg = batchNegotiations[batchId][currentProvider];
            if (FHE.isInitialized(neg.targetPrice)) {
                if (!initializedSums) {
                    sumTargetPrices = neg.targetPrice;
                    sumBottomLines = neg.bottomLine;
                    initializedSums = true;
                } else {
                    sumTargetPrices = FHE.add(sumTargetPrices, neg.targetPrice);
                    sumBottomLines = FHE.add(sumBottomLines, neg.bottomLine);
                }
            }
            // Move to next provider (simplified iteration logic for example)
            // In a real scenario, you'd need a list of providers or a more robust iteration method
            currentProvider = address(uint160(uint256(currentProvider) + 1));
            if (currentProvider.code.length == 0 && currentProvider.balance == 0) break; // Basic check for non-existent address
        }


        if (!initializedSums) { // No valid negotiations found
            revert("No valid negotiations to decrypt");
        }

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(sumTargetPrices);
        cts[1] = FHE.toBytes32(sumBottomLines);

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // a. Replay Guard
        if (ctx.processed) revert ReplayAttempt();

        // b. State Verification
        // Rebuild cts array from current contract storage in the *exact same order* as in requestDecryptionForBatch
        euint32 memory sumTargetPrices;
        euint32 memory sumBottomLines;
        bool initializedSums = false;

        address currentProvider = address(uint160(batchNegotiations[ctx.batchId].slot));
        while (currentProvider != address(0)) {
            Negotiation storage neg = batchNegotiations[ctx.batchId][currentProvider];
            if (FHE.isInitialized(neg.targetPrice)) {
                if (!initializedSums) {
                    sumTargetPrices = neg.targetPrice;
                    sumBottomLines = neg.bottomLine;
                    initializedSums = true;
                } else {
                    sumTargetPrices = FHE.add(sumTargetPrices, neg.targetPrice);
                    sumBottomLines = FHE.add(sumBottomLines, neg.bottomLine);
                }
            }
            currentProvider = address(uint160(uint256(currentProvider) + 1));
            if (currentProvider.code.length == 0 && currentProvider.balance == 0) break;
        }
        
        if (!initializedSums) revert("No valid negotiations to verify state"); // Should not happen if request was valid

        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = FHE.toBytes32(sumTargetPrices);
        currentCts[1] = FHE.toBytes32(sumBottomLines);

        bytes32 currentHash = _hashCiphertexts(currentCts);
        if (currentHash != ctx.stateHash) {
            revert StateMismatch();
        }

        // c. Proof Verification
        FHE.checkSignatures(requestId, cleartexts, proof);

        // d. Decode & Finalize
        // Cleartexts order must match cts order: sumTargetPrices, sumBottomLines
        uint32 sumTargetPricesCleartext = abi.decode(cleartexts[0:32], (uint32));
        uint32 sumBottomLinesCleartext = abi.decode(cleartexts[32:64], (uint32));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, sumTargetPricesCleartext, sumBottomLinesCleartext);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 memory val) internal pure {
        if (!FHE.isInitialized(val)) {
            // Initialize with 0 if not already initialized.
            // This is a placeholder; specific initialization logic depends on the use case.
            // For this example, we assume inputs are already initialized by the provider.
            // If not, this ensures they are, though a real system might want to track uninitialized inputs.
            val = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 memory val) internal pure {
        if (!FHE.isInitialized(val)) {
            revert("euint32 not initialized");
        }
    }
}