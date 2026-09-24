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

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PRICE_TYPEHASH = keccak256(
        "PriceAttestation(bytes32 marketId,uint256 priceE18,uint256 spotPriceE18,uint256 confidenceBps,uint64 timestamp,uint64 sequence,uint64 expiry)"
    );
    bytes32 private constant NAME_HASH = keccak256("FloatSheetsOracle");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 public constant MAX_SPOT_TWAP_DEVIATION_BPS = 50;
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
    address public signer;
    mapping(bytes32 => bool) public marketEnabled;
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
        signer = newSigner;
        emit SignerUpdated(newSigner);
    }

    function setMarketEnabled(bytes32 marketId, bool enabled) external onlyOwner {
        marketEnabled[marketId] = enabled;
        emit MarketUpdated(marketId, enabled);
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
