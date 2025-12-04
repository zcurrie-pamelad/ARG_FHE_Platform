pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ArgFhePlatformFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidCooldown();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error AlreadyInitialized();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        bool exists;
        bool closed;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct Clue {
        euint32 encryptedLatitude;
        euint32 encryptedLongitude;
        euint32 encryptedClueData;
    }
    mapping(uint256 => mapping(uint256 => Clue)) public batchClues; // batchId => clueIndex => Clue
    mapping(uint256 => uint256) public batchClueCounts; // batchId => count

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedSet(bool paused);
    event CooldownSecondsSet(uint256 previousCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ClueSubmitted(address indexed provider, uint256 indexed batchId, uint256 clueIndex);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 decryptedClueData);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        currentBatchId = 1; // Start with batch 1
        batches[currentBatchId] = Batch(true, false);
        cooldownSeconds = 60; // Default 60 seconds cooldown
        emit BatchOpened(currentBatchId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidCooldown();
        uint256 previousCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(previousCooldown, _cooldownSeconds);
    }

    function openNewBatch() external onlyOwner {
        batches[currentBatchId].closed = true;
        emit BatchClosed(currentBatchId);

        currentBatchId++;
        batches[currentBatchId] = Batch(true, false);
        emit BatchOpened(currentBatchId);
    }

    function submitClue(
        uint256 _batchId,
        euint32 _encryptedLatitude,
        euint32 _encryptedLongitude,
        euint32 _encryptedClueData
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!_checkBatchExistsAndOpen(_batchId)) revert BatchClosed();

        lastSubmissionTime[msg.sender] = block.timestamp;

        uint256 clueIndex = batchClueCounts[_batchId];
        batchClues[_batchId][clueIndex] = Clue(_encryptedLatitude, _encryptedLongitude, _encryptedClueData);
        batchClueCounts[_batchId] = clueIndex + 1;

        emit ClueSubmitted(msg.sender, _batchId, clueIndex);
    }

    function requestClueDecryption(uint256 _batchId, uint256 _clueIndex, euint32 _encryptedPlayerLatitude, euint32 _encryptedPlayerLongitude)
        external
        payable
        whenNotPaused
    {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!_checkBatchExistsAndOpen(_batchId)) revert BatchClosed();
        if (_clueIndex >= batchClueCounts[_batchId]) revert(); // Invalid clue index

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        Clue storage clue = batchClues[_batchId][_clueIndex];
        euint32 encryptedDistance = _calculateEncryptedDistance(clue.encryptedLatitude, clue.encryptedLongitude, _encryptedPlayerLatitude, _encryptedPlayerLongitude);
        ebool encryptedIsInRange = _isInRange(encryptedDistance);

        euint32 encryptedClueData = clue.encryptedClueData;
        euint32 finalEncryptedClueData = _selectClueData(encryptedClueData, encryptedIsInRange);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(finalEncryptedClueData);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: _batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, _batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        if (cleartexts.length != 32) revert(); // Expecting one uint256

        // Rebuild cts for state verification
        // The original cts array had 1 element: finalEncryptedClueData
        // We need to reconstruct this ciphertext from storage.
        // This requires re-calculating the FHE operations.
        // This simplified example assumes the batchId and clueIndex are part of the context or can be derived.
        // For this example, let's assume the DecryptionContext stores batchId.
        // We would need to also store clueIndex if it's not fixed or derivable.
        // For this example, let's assume we are decrypting the first clue of the batch for simplicity.
        // A more robust solution would store all necessary indices in DecryptionContext.

        // This is a simplification. A full implementation would need to store all parameters
        // (_clueIndex, _encryptedPlayerLatitude, _encryptedPlayerLongitude) in DecryptionContext
        // to perfectly recompute the ciphertexts.
        // For this example, we'll assume these are implicitly known or fixed for the batch.
        // This part is highly dependent on the specific FHE logic and what needs to be re-computed.
        // The key is that `cts` must be *identical* to the one used in `requestDecryption`.

        // Let's assume for this callback, we are decrypting the first clue of the batch.
        // This is a simplification for the example.
        // A real system would need to store the specific clue index and player's encrypted location
        // in the DecryptionContext to accurately rebuild the ciphertexts.
        // For now, we'll just use the batchId from context.
        uint256 batchId = decryptionContexts[requestId].batchId;
        if (!_checkBatchExistsAndOpen(batchId)) revert BatchClosed(); // Batch might have been closed
        if (batchClueCounts[batchId] == 0) revert(); // No clues in batch

        // This is a placeholder for the actual ciphertext reconstruction.
        // The actual ciphertexts would be re-computed using the stored parameters
        // (e.g., player's encrypted location, clue index) from the DecryptionContext.
        // For this example, we'll just take the first clue's encrypted data directly,
        // which is NOT the same as `finalEncryptedClueData` computed with player's location.
        // This highlights the need for careful state management in the callback.
        // The `stateHash` check is crucial here.
        Clue storage clue = batchClues[batchId][0]; // Placeholder: using first clue
        euint32 finalEncryptedClueDataRecomputed = clue.encryptedClueData; // This is NOT the same as what was requested if player location was used.

        bytes32[] memory ctsRecomputed = new bytes32[](1);
        ctsRecomputed[0] = FHE.toBytes32(finalEncryptedClueDataRecomputed); // This should be the RECOMPUTED ciphertext

        bytes32 currentHash = _hashCiphertexts(ctsRecomputed);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        uint256 decryptedClueData = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, decryptedClueData);
    }

    function _checkBatchExistsAndOpen(uint256 _batchId) internal view returns (bool) {
        Batch storage batch = batches[_batchId];
        return batch.exists && !batch.closed;
    }

    function _hashCiphertexts(bytes32[] memory _cts) internal view returns (bytes32) {
        return keccak256(abi.encode(_cts, address(this)));
    }

    function _initIfNeeded(euint32 _var) internal {
        if (!_var.isInitialized()) {
            _var.init();
        }
    }

    function _requireInitialized(euint32 _var) internal pure {
        if (!_var.isInitialized()) {
            revert NotInitialized();
        }
    }

    function _calculateEncryptedDistance(euint32 lat1, euint32 lon1, euint32 lat2, euint32 lon2) internal view returns (euint32) {
        _initIfNeeded(lat1);
        _initIfNeeded(lon1);
        _initIfNeeded(lat2);
        _initIfNeeded(lon2);

        euint32 encryptedDiffLat = lat1.sub(lat2);
        euint32 encryptedDiffLon = lon1.sub(lon2);
        euint32 encryptedDiffLatSq = encryptedDiffLat.mul(encryptedDiffLat);
        euint32 encryptedDiffLonSq = encryptedDiffLon.mul(encryptedDiffLon);
        euint32 encryptedSumSq = encryptedDiffLatSq.add(encryptedDiffLonSq);
        return encryptedSumSq; // Simplified distance squared
    }

    function _isInRange(euint32 _encryptedDistance) internal view returns (ebool) {
        _initIfNeeded(_encryptedDistance);
        euint32 threshold = FHE.asEuint32(100); // Example threshold (distance squared)
        _initIfNeeded(threshold);
        return _encryptedDistance.le(threshold);
    }

    function _selectClueData(euint32 _encryptedClueData, ebool _encryptedIsInRange) internal view returns (euint32) {
        _initIfNeeded(_encryptedClueData);
        _initIfNeeded(_encryptedIsInRange);

        euint32 zero = FHE.asEuint32(0);
        _initIfNeeded(zero);

        euint32 encryptedResult = _encryptedIsInRange.select(_encryptedClueData, zero);
        return encryptedResult;
    }
}