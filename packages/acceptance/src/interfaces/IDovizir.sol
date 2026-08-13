// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Dovizir M1 protocol interfaces — REFEREE COPY (frozen)
/// @notice Both experiment arms implement these exactly. The acceptance suite
/// tests only through these interfaces plus the events below. Amendments
/// require a spec-bug finding (see docs/experiment/PROTOCOL.md §5).

/// @dev IOU is issuer-tranched: ERC-1155 with one token id per Sarraf
/// (id = uint256(uint160(sarraf))). Fungible within a tranche, 1:1 across
/// tranches via migrate(). Transfer authorizations are EIP-3009-style for
/// courier mode.
interface IIouToken {
    // ERC-1155 core (balanceOf, safeTransferFrom, ...) is assumed via ERC-1155 compliance.

    /// EIP-3009-style: transfer `amount` of tranche `id` from signer to `to`,
    /// authorized by an EIP-712 signature over (from,to,id,amount,validAfter,validBefore,nonce).
    /// Relayable by anyone (courier mode). One-time nonce per `from`.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function authorizationState(address from, bytes32 nonce) external view returns (bool used);

    /// Mint/burn are pool-only.
    function mint(address to, uint256 trancheId, uint256 amount) external;
    function burn(address from, uint256 trancheId, uint256 amount) external;

    event AuthorizationUsed(address indexed from, bytes32 indexed nonce);
}

interface IMemberRegistry {
    /// A member belongs to exactly one sponsoring Sarraf. Onboarding is
    /// Sarraf-initiated (KYC-lite happens off-chain; on-chain is the record).
    function addMember(address member) external; // caller = certified Sarraf
    function removeMember(address member) external; // caller = member's Sarraf
    function sarrafOf(address member) external view returns (address); // 0x0 if none
    function isMember(address member) external view returns (bool);

    /// Re-homing: called by the new Sarraf's open-acceptance flow (see IReservePool.migrate).
    function rehome(address member, address newSarraf) external;

    event MemberAdded(address indexed member, address indexed sarraf);
    event MemberRehomed(address indexed member, address indexed fromSarraf, address indexed toSarraf);
}

interface IReservePool {
    /// Sarraf deposits USDT (mock ERC-20) into their tranche backing and may
    /// mint IOUs of their own tranche 1:1 against it. NO unfunded issuance in
    /// M1 (act-3 headroom is out of scope; CreditOracle is written but not enforced).
    function deposit(uint256 usdtAmount) external; // caller = certified Sarraf
    function issue(address to, uint256 amount) external; // caller = certified Sarraf; to = their member
    /// Redeem burns holder's IOUs of tranche `sarraf`; charges redemption fee
    /// (fee goes to InsuranceFund); releases USDT to holder.
    function redeem(address sarraf, uint256 amount) external;

    /// Holder-initiated migration from a non-certified Sarraf's tranche to a
    /// consenting certified one: burn old-tranche IOU, move backing USDT
    /// attribution, mint new-tranche IOU. Reverts if `fromSarraf` still
    /// certified, if `toSarraf` not accepting, or if from-tranche impaired.
    function migrate(address fromSarraf, address toSarraf, uint256 amount) external;

    function backingOf(address sarraf) external view returns (uint256 usdt);
    function outstandingOf(address sarraf) external view returns (uint256 ious);

    event Deposited(address indexed sarraf, uint256 amount);
    event Issued(address indexed sarraf, address indexed to, uint256 amount);
    event Redeemed(address indexed sarraf, address indexed holder, uint256 amount, uint256 fee);
    event Migrated(address indexed holder, address indexed fromSarraf, address indexed toSarraf, uint256 amount);
}

interface IInsuranceFund {
    /// Receives the 0.9% (90 bps) redemption fee. Accounting split 50/50:
    /// overseeing-share and maintenance-share buckets (act-2 hook — no
    /// distribution logic in M1, only the split bookkeeping).
    function totalReserves() external view returns (uint256);
    function overseeingShare() external view returns (uint256);
    function maintenanceShare() external view returns (uint256);

    /// Pays a double-spend victim (NoteVault-only caller).
    function payClaim(address victim, uint256 amount) external;

    event FeeReceived(uint256 amount);
    event ClaimPaid(address indexed victim, uint256 amount, bytes32 indexed noteSerial);
}

interface ISarrafRegistry {
    /// Certified iff 7-day TWAB of deposit >= min(totalDeposits/5, FLOOR_CAP).
    /// FLOOR_CAP = 1_000_000e6 (mock USDT, 6 decimals). Hysteresis: enter at
    /// >=100% of floor; drop only after <90% of floor for 3 consecutive
    /// evaluations. evaluate() callable at most once per 24h period.
    function evaluate() external;
    function isCertified(address sarraf) external view returns (bool);
    function floor() external view returns (uint256);
    function twabOf(address sarraf) external view returns (uint256);
    function setAccepting(bool accepting) external; // Sarraf opts into receiving migrations
    function isAccepting(address sarraf) external view returns (bool);

    event Certified(address indexed sarraf);
    event Decertified(address indexed sarraf);
}

interface INoteVault {
    /// Member locks IOUs of their sponsor's tranche and commits to a batch of
    /// note serials (merkle root). Notes expire; expired unspent value refunds.
    /// capOf(member) limits total locked value outstanding (base cap in M1).
    function carve(bytes32 batchRoot, uint256 amount, uint64 expiry) external;
    /// Reconcile a spend transcript: proves serial ∈ batch, recipient-bound
    /// (invoice hash incl. recipient + nonce), signed by the carver. First
    /// presentation pays `recipient` from the locked value (mints them IOU of
    /// the carver's tranche). Second presentation of the same serial =
    /// double-spend: emits conviction, seizes carver's remaining locked value,
    /// pays the later victim via InsuranceFund if seizure short.
    function reconcile(
        bytes32 batchRoot,
        bytes32 serial,
        bytes32[] calldata proof,
        bytes calldata transcript,
        bytes calldata carverSig
    ) external;
    function refundExpired(bytes32 batchRoot) external;

    function isSpent(bytes32 serial) external view returns (bool);
    function capOf(address member) external view returns (uint256);
    function lockedOf(address member) external view returns (uint256);

    event Carved(address indexed member, bytes32 indexed batchRoot, uint256 amount, uint64 expiry);
    event NoteReconciled(bytes32 indexed serial, address indexed recipient, uint256 amount);
    event DoubleSpendConvicted(bytes32 indexed serial, address indexed carver, address indexed victim);
    event ExpiredRefunded(bytes32 indexed batchRoot, uint256 amount);
}
