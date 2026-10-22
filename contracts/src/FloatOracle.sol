// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract FloatOracle {
    error Unauthorized();
    error InvalidSignature();
    error MarketDisabled();
    error AttestationExpired();
    error InvalidTimestamp();
    error InvalidSequence();
    error InvalidPrice();
    error ZeroAddress();
    error NoPendingChange();
    error TimelockNotReady();

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PRICE_TYPEHASH = keccak256(
        "PriceAttestation(bytes32 marketId,uint256 priceE18,uint256 spotPriceE18,uint256 confidenceBps,uint64 timestamp,uint64 sequence,uint64 expiry)"
    );
    bytes32 private constant NAME_HASH = keccak256("FloatSheetsOracle");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 public constant MAX_SPOT_TWAP_DEVIATION_BPS = 50;
    uint256 public constant MAX_PRICE_JUMP_BPS = 2_000;
    uint64 public constant CONFIG_DELAY = 0;
    uint256 private constant BPS = 10_000;

    struct PriceAttestation {
        bytes32 marketId;
        uint256 priceE18;
        uint256 spotPriceE18;
        uint256 confidenceBps;
        uint64 timestamp;
        uint64 sequence;
        uint64 expiry;
    }

    struct Price {
        uint256 priceE18;
        uint256 spotPriceE18;
        uint256 confidenceBps;
        uint256 spotTwapDeviationBps;
        uint64 timestamp;
        uint64 sequence;
        bool circuitBroken;
    }

    address public owner;
    address public pendingOwner;
    uint64 public pendingOwnerAt;
    address public signer;
    address public pendingSigner;
    uint64 public pendingSignerAt;
    mapping(bytes32 => uint64) public pendingMarketEnableAt;
    mapping(bytes32 => bool) public marketEnabled;
    mapping(bytes32 => bool) public marketEverEnabled;
    mapping(bytes32 => Price) private prices;

    event PricePublished(
        bytes32 indexed marketId,
        uint256 priceE18,
        uint256 spotPriceE18,
        uint256 spotTwapDeviationBps,
        bool circuitBroken,
        uint64 sequence,
        uint64 timestamp
    );
    event SignerUpdated(address indexed signer);
    event MarketUpdated(bytes32 indexed marketId, bool enabled);
    event SignerChangeScheduled(address indexed signer, uint64 effectiveAt);
    event OwnershipTransferStarted(address indexed pendingOwner, uint64 effectiveAt);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner, address initialSigner) {
        if (initialOwner == address(0) || initialSigner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        signer = initialSigner;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        pendingSigner = newSigner;
        pendingSignerAt = uint64(block.timestamp + CONFIG_DELAY);
        emit SignerChangeScheduled(newSigner, pendingSignerAt);
    }

    function applySigner() external {
        if (pendingSigner == address(0)) revert NoPendingChange();
        if (block.timestamp < pendingSignerAt) revert TimelockNotReady();
        signer = pendingSigner;
        pendingSigner = address(0);
        pendingSignerAt = 0;
        emit SignerUpdated(signer);
    }

    function scheduleOwnershipTransfer(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert ZeroAddress();
        pendingOwner = nextOwner;
        pendingOwnerAt = uint64(block.timestamp + CONFIG_DELAY);
        emit OwnershipTransferStarted(nextOwner, pendingOwnerAt);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        if (block.timestamp < pendingOwnerAt) revert TimelockNotReady();
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        pendingOwnerAt = 0;
        emit OwnershipTransferred(previousOwner, owner);
    }

    function setMarketEnabled(bytes32 marketId, bool enabled) external onlyOwner {
        if (!enabled) {
            marketEnabled[marketId] = false;
            pendingMarketEnableAt[marketId] = 0;
            emit MarketUpdated(marketId, false);
        } else {
            pendingMarketEnableAt[marketId] = uint64(block.timestamp + CONFIG_DELAY);
        }
    }

    /// @notice Enables the first oracle publication for a new launch market.
    ///         All subsequent market enables are also immediately applicable.
    function enableInitialMarket(bytes32 marketId) external onlyOwner {
        if (marketEverEnabled[marketId] || marketEnabled[marketId]) revert NoPendingChange();
        marketEverEnabled[marketId] = true;
        marketEnabled[marketId] = true;
        emit MarketUpdated(marketId, true);
    }

    function applyMarketEnabled(bytes32 marketId) external {
        uint64 effectiveAt = pendingMarketEnableAt[marketId];
        if (effectiveAt == 0) revert NoPendingChange();
        if (block.timestamp < effectiveAt) revert TimelockNotReady();
        marketEnabled[marketId] = true;
        marketEverEnabled[marketId] = true;
        pendingMarketEnableAt[marketId] = 0;
        emit MarketUpdated(marketId, true);
    }

    function getPrice(bytes32 marketId) external view returns (Price memory) {
        return prices[marketId];
    }

    function publish(PriceAttestation calldata attestation, bytes calldata signature) external {
        if (!marketEnabled[attestation.marketId]) revert MarketDisabled();
        if (attestation.expiry < block.timestamp) revert AttestationExpired();
        if (attestation.timestamp > block.timestamp) revert InvalidTimestamp();
        if (attestation.sequence <= prices[attestation.marketId].sequence) revert InvalidSequence();
        if (attestation.priceE18 == 0 || attestation.spotPriceE18 == 0) revert InvalidPrice();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator(),
                keccak256(
                    abi.encode(
                        PRICE_TYPEHASH,
                        attestation.marketId,
                        attestation.priceE18,
                        attestation.spotPriceE18,
                        attestation.confidenceBps,
                        attestation.timestamp,
                        attestation.sequence,
                        attestation.expiry
                    )
                )
            )
        );
        if (_recover(digest, signature) != signer) revert InvalidSignature();
        uint256 deviation = attestation.spotPriceE18 > attestation.priceE18
            ? (attestation.spotPriceE18 - attestation.priceE18) * BPS / attestation.priceE18
            : (attestation.priceE18 - attestation.spotPriceE18) * BPS / attestation.priceE18;
        bool circuitBroken = deviation > MAX_SPOT_TWAP_DEVIATION_BPS;
        Price memory previous = prices[attestation.marketId];
        if (previous.priceE18 != 0) {
            uint256 jumpBps = attestation.priceE18 > previous.priceE18
                ? (attestation.priceE18 - previous.priceE18) * BPS / previous.priceE18
                : (previous.priceE18 - attestation.priceE18) * BPS / previous.priceE18;
            if (jumpBps > MAX_PRICE_JUMP_BPS) {
                prices[attestation.marketId] = Price(
                    previous.priceE18,
                    previous.spotPriceE18,
                    previous.confidenceBps,
                    previous.spotTwapDeviationBps,
                    previous.timestamp,
                    attestation.sequence,
                    true
                );
                emit PricePublished(
                    attestation.marketId,
                    previous.priceE18,
                    previous.spotPriceE18,
                    previous.spotTwapDeviationBps,
                    true,
                    attestation.sequence,
                    previous.timestamp
                );
                return;
            }
        }
        prices[attestation.marketId] = Price(
            attestation.priceE18,
            attestation.spotPriceE18,
            attestation.confidenceBps,
            deviation,
            attestation.timestamp,
            attestation.sequence,
            circuitBroken
        );
        emit PricePublished(
            attestation.marketId,
            attestation.priceE18,
            attestation.spotPriceE18,
            deviation,
            circuitBroken,
            attestation.sequence,
            attestation.timestamp
        );
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
