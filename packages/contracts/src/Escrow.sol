// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @dev Minimal view of the tranched ERC-1155 IOU this escrow custodies.
/// Kept local (not the full IIouToken) so the escrow depends only on the two
/// entry points it actually calls: balance reads and safe transfers.
interface IEscrowIou {
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data)
        external;
}

/// @title Escrow — P2P IOU-for-fiat escrow with Sarraf arbitration (fiat-ramp §4)
/// @notice A **maker** locks `usdtAmount` of a single IOU tranche
/// `T = uint256(uint160(sellerSarraf))`; a **taker** pays local-currency fiat
/// off-chain and commits the bank-receipt hash on-chain. Happy path: the maker
/// confirms and the IOU releases to the taker. Griefing paths: the maker
/// refunds after the payment window lapses with no receipt, or either party
/// escalates a paid order to **dispute**. The dispute is decided by the tranche's
/// issuing Sarraf — the **arbiter derived on-chain from the tranche id**, never a
/// caller-supplied address, so it cannot be spoofed.
///
/// Security posture (the review will hammer these — fiat-ramp §6):
///  - arbiter = `address(uint160(order.trancheId))`, recomputed at resolve time;
///  - arbiter can never be the maker or the taker of the same order (no self-deal);
///  - Checks-Effects-Interactions: every state write lands before any IOU move;
///  - `nonReentrant` on every state-changing external entry point;
///  - the receipt hash is write-once (immutable after `claimFiatPaid`);
///  - one active fill per order; no double-settle / double-resolve (terminal
///    states are unreachable as preconditions);
///  - windows are bounded and monotonic (deadlines only ever move forward);
///  - zero-amount / zero-address guards on creation;
///  - custody accepted only for a deposit the escrow itself initiated, so no
///    stray IOU can be parked against the escrow's accounting;
///  - an event for every transition (the indexer's order book depends on them).
contract Escrow {
    // ------------------------------------------------------------- constants

    /// ERC-1155 single-receive magic value (`onERC1155Received.selector`).
    bytes4 internal constant _ERC1155_RECEIVED = 0xf23a6e61;
    /// ERC-1155 batch-receive magic value — declared only to reject batches.
    bytes4 internal constant _ERC1155_BATCH_RECEIVED = 0xbc197c81;

    /// Payment-window bounds (taker's time to pay fiat after a fill).
    uint64 public constant MIN_PAYMENT_WINDOW = 15 minutes;
    uint64 public constant MAX_PAYMENT_WINDOW = 30 days;
    /// Fixed maker-confirm window after the receipt is claimed. Bounded and
    /// not caller-settable so a maker cannot grief with a zero/absurd value.
    /// Also gates a TAKER's dispute: a taker may only escalate a claimed order
    /// once this window has elapsed, so the maker always gets their chance to
    /// confirm first (stops the instant fill→claim→dispute griefing lock).
    uint64 public constant CONFIRM_WINDOW = 2 days;
    /// Backstop window after a dispute is raised. The tranche Sarraf may resolve
    /// at ANY time; the protocol backstop arbiter may resolve ONLY after this
    /// timeout, so a dispute can never be permanently stranded by an absent
    /// Sarraf. It is a fallback human resolver, NOT an auto-default to a side.
    uint64 public constant DISPUTE_TIMEOUT = 7 days;

    // --------------------------------------------------------------- types

    enum Status {
        None, //          0 — order id never created
        Open, //          1 — IOU locked, awaiting a taker
        Matched, //       2 — taker committed; payment window running
        FiatClaimed, //   3 — receipt hash set; confirm window running
        Settled, //       4 — maker confirmed; IOU released to taker  (terminal)
        Refunded, //      5 — cancelled/timed-out; IOU back to maker  (terminal)
        Disputed, //      6 — escalated; awaiting the arbiter
        ResolvedTaker, // 7 — arbiter awarded the IOU to the taker     (terminal)
        ResolvedMaker //  8 — arbiter refunded the IOU to the maker    (terminal)
    }

    struct Order {
        address maker; //        seller of IOU, wants fiat
        address taker; //        buyer with fiat, wants IOU (0x0 until MATCHED)
        uint256 trancheId; //    IOU tranche id == uint160(arbiter Sarraf)
        uint256 usdtAmount; //   IOU units locked (6-dp, like the IOU)
        uint256 fiatAmount; //   agreed local-currency amount (off-chain leg)
        bytes32 quoteHash; //    hash of the agreed price record (evidence)
        bytes32 receiptHash; //  hash of the fiat receipt (write-once)
        uint64 paymentWindow; // taker's fiat-payment window (bounded)
        uint64 matchedAt; //     fill timestamp (0 until MATCHED)
        uint64 fiatClaimedAt; // receipt timestamp (0 until FIAT_CLAIMED)
        uint64 disputedAt; //    dispute timestamp (0 until DISPUTED); backstop clock
        Status status;
        bool paying; //          taker has committed to paying (markPaying); freezes cancel
        string fiat; //          currency code, e.g. "IRR" | "TRY"
    }

    // --------------------------------------------------------------- storage

    IEscrowIou public immutable iou;

    /// Protocol backstop arbiter — a human/trusted fallback resolver set at
    /// deploy. It can resolve a dispute ONLY after {DISPUTE_TIMEOUT} elapses, so
    /// funds are never permanently stranded if the tranche Sarraf goes absent.
    address public immutable backstopArbiter;

    uint256 public nextOrderId;
    mapping(uint256 => Order) internal _orders;

    /// Reentrancy guard (1 = unlocked, 2 = locked).
    uint256 private _lock = 1;

    /// Custody gate for {onERC1155Received}: a non-wrapping two-field sentinel.
    /// During a createOrder deposit `_expecting` is set true and `_expectedId`
    /// to the tranche id, both cleared immediately after — so the escrow accepts
    /// ONLY the inbound transfer it just initiated. Using a bool (not `id + 1`)
    /// avoids the wrap where tranche id == type(uint256).max would forge a "0 =
    /// expect nothing" gate and let a stray deposit through.
    bool private _expecting;
    uint256 private _expectedId;

    // ---------------------------------------------------------------- events

    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        address indexed arbiter,
        uint256 trancheId,
        uint256 usdtAmount,
        uint256 fiatAmount,
        string fiat,
        bytes32 quoteHash,
        uint64 paymentWindow
    );
    event OrderFilled(uint256 indexed orderId, address indexed taker, uint64 paymentDeadline);
    event PayingMarked(uint256 indexed orderId, address indexed taker);
    event FiatClaimed(uint256 indexed orderId, address indexed taker, bytes32 receiptHash, uint64 confirmDeadline);
    event OrderSettled(uint256 indexed orderId, address indexed taker, uint256 usdtAmount);
    event OrderRefunded(uint256 indexed orderId, address indexed maker, uint256 usdtAmount);
    event DisputeRaised(uint256 indexed orderId, address indexed by);
    event DisputeResolved(
        uint256 indexed orderId, address indexed arbiter, bool toTaker, address indexed beneficiary, uint256 usdtAmount
    );

    // -------------------------------------------------------------- modifiers

    modifier nonReentrant() {
        require(_lock == 1, "Escrow: reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------- construction

    constructor(IEscrowIou iou_, address backstopArbiter_) {
        require(address(iou_) != address(0), "Escrow: zero iou");
        require(backstopArbiter_ != address(0), "Escrow: zero backstop");
        iou = iou_;
        backstopArbiter = backstopArbiter_;
    }

    // --------------------------------------------------------------- lifecycle

    /// @notice Maker opens an order, locking `usdtAmount` of tranche
    /// `T = uint160(sellerSarraf)` into the escrow. The arbiter is DERIVED from
    /// the tranche (`sellerSarraf`) — it is never trusted as a free parameter.
    /// @dev CEI: the order is fully written (status Open) BEFORE the IOU is
    /// pulled in. The maker must have `setApprovalForAll(escrow, true)` on the
    /// IOU first. Reverts if the maker is the tranche's own Sarraf (self-deal).
    function createOrder(
        address sellerSarraf,
        uint256 usdtAmount,
        string calldata fiat,
        uint256 fiatAmount,
        bytes32 quoteHash,
        uint64 paymentWindow
    ) external nonReentrant returns (uint256 orderId) {
        require(sellerSarraf != address(0), "Escrow: zero sarraf");
        require(usdtAmount > 0, "Escrow: zero amount");
        require(fiatAmount > 0, "Escrow: zero fiat amount");
        require(bytes(fiat).length > 0, "Escrow: empty fiat");
        require(quoteHash != bytes32(0), "Escrow: zero quote");
        require(
            paymentWindow >= MIN_PAYMENT_WINDOW && paymentWindow <= MAX_PAYMENT_WINDOW,
            "Escrow: bad payment window"
        );

        uint256 trancheId = uint256(uint160(sellerSarraf));
        // Self-deal guard #1: the tranche's issuing Sarraf (the future arbiter)
        // may not also be the maker. A Sarraf selling their own tranche must use
        // a different tranche or forgo self-arbitration.
        require(msg.sender != sellerSarraf, "Escrow: arbiter is maker");

        orderId = nextOrderId++;
        Order storage o = _orders[orderId];
        o.maker = msg.sender;
        o.trancheId = trancheId;
        o.usdtAmount = usdtAmount;
        o.fiat = fiat;
        o.fiatAmount = fiatAmount;
        o.quoteHash = quoteHash;
        o.paymentWindow = paymentWindow;
        o.status = Status.Open;

        emit OrderCreated(
            orderId, msg.sender, sellerSarraf, trancheId, usdtAmount, fiatAmount, fiat, quoteHash, paymentWindow
        );

        // Interaction last. Gate {onERC1155Received} to exactly this deposit.
        _expecting = true;
        _expectedId = trancheId;
        iou.safeTransferFrom(msg.sender, address(this), trancheId, usdtAmount, "");
        _expecting = false;
        _expectedId = 0;
    }

    /// @notice Taker accepts an OPEN order. One active fill per order: the
    /// Open→Matched transition consumes the only fillable state, so a second
    /// fill reverts. Starts the payment-window timer.
    function fillOrder(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        require(o.status == Status.Open, "Escrow: not open");
        require(msg.sender != o.maker, "Escrow: maker cannot fill");
        // Self-deal guard #2: the arbiter (tranche Sarraf) cannot be the taker.
        require(msg.sender != address(uint160(o.trancheId)), "Escrow: arbiter is taker");

        o.taker = msg.sender;
        o.matchedAt = uint64(block.timestamp);
        o.status = Status.Matched;

        emit OrderFilled(orderId, msg.sender, uint64(block.timestamp) + o.paymentWindow);
    }

    /// @notice Taker commits the off-chain bank-receipt hash. Write-once: the
    /// hash can never be changed once set (the state guard forbids re-entry to
    /// this transition, and the explicit check is defense-in-depth). Starts the
    /// maker-confirm window.
    function claimFiatPaid(uint256 orderId, bytes32 receiptHash) external nonReentrant {
        Order storage o = _orders[orderId];
        require(o.status == Status.Matched, "Escrow: not matched");
        require(msg.sender == o.taker, "Escrow: only taker");
        require(receiptHash != bytes32(0), "Escrow: zero receipt");
        require(o.receiptHash == bytes32(0), "Escrow: receipt set");

        o.receiptHash = receiptHash;
        o.fiatClaimedAt = uint64(block.timestamp);
        o.status = Status.FiatClaimed;

        emit FiatClaimed(orderId, msg.sender, receiptHash, uint64(block.timestamp) + CONFIRM_WINDOW);
    }

    /// @notice Taker signals they have committed to sending the fiat, freezing
    /// the maker's post-deadline {cancel} so a maker cannot cancel-vs-claim race
    /// them out of the IOU after real fiat has been sent but before the receipt
    /// is uploaded. Callable only by the taker while MATCHED. This is not itself
    /// a maker-lock: if the taker marks-paying but never claims within the
    /// payment window, the maker's exit becomes {raiseDispute} (backstop-
    /// resolvable) rather than a silent refund.
    function markPaying(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        require(o.status == Status.Matched, "Escrow: not matched");
        require(msg.sender == o.taker, "Escrow: only taker");

        o.paying = true;
        emit PayingMarked(orderId, msg.sender);
    }

    /// @notice Maker confirms the fiat arrived → IOU releases to the taker.
    /// @dev CEI: status is set terminal BEFORE the transfer, so the receiver
    /// callback cannot re-enter into any further state change.
    function confirmReceived(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        require(o.status == Status.FiatClaimed, "Escrow: not claimed");
        require(msg.sender == o.maker, "Escrow: only maker");

        o.status = Status.Settled;
        emit OrderSettled(orderId, o.taker, o.usdtAmount);

        iou.safeTransferFrom(address(this), o.taker, o.trancheId, o.usdtAmount, "");
    }

    /// @notice Maker reclaims the IOU. Allowed pre-fill (OPEN), or after the
    /// payment window elapses while still MATCHED with no receipt claimed AND the
    /// taker has not signalled {markPaying}. Once the taker has claimed a receipt
    /// (FIAT_CLAIMED) or committed to paying this silent-refund path is closed —
    /// the maker must confirm or {raiseDispute}. This blocks the cancel-vs-claim
    /// race where a maker reclaims the IOU right at the deadline after the taker
    /// already sent real fiat but before the receipt landed on-chain.
    function cancel(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        require(msg.sender == o.maker, "Escrow: only maker");
        bool prefill = o.status == Status.Open;
        bool timedOut = o.status == Status.Matched
            && !o.paying
            && block.timestamp > uint256(o.matchedAt) + uint256(o.paymentWindow);
        require(prefill || timedOut, "Escrow: not cancelable");

        o.status = Status.Refunded;
        emit OrderRefunded(orderId, o.maker, o.usdtAmount);

        iou.safeTransferFrom(address(this), o.maker, o.trancheId, o.usdtAmount, "");
    }

    /// @notice Escalate an order to the arbiter. Two entrances:
    ///  - FIAT_CLAIMED (normal): the MAKER may raise at any time (choosing
    ///    arbitration on their own order is not griefing); the TAKER may raise
    ///    only after the maker-confirm window elapses. That gate wires up the
    ///    previously-dead CONFIRM_WINDOW: it stops the instant fill→claim(garbage
    ///    hash)→dispute lock and the front-run of a clean {confirmReceived}.
    ///  - MATCHED + markPaying (maker's stalled-taker exit): once the taker has
    ///    committed to paying, {cancel} is frozen; if the payment window then
    ///    elapses with no receipt, the MAKER escalates here instead of a silent
    ///    refund. Combined with the backstop this is always resolvable.
    function raiseDispute(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];

        bool claimed = o.status == Status.FiatClaimed;
        // Maker's exit when a committed taker stalls past the payment window.
        bool stalledExit = o.status == Status.Matched
            && msg.sender == o.maker
            && o.paying
            && block.timestamp > uint256(o.matchedAt) + uint256(o.paymentWindow);
        require(claimed || stalledExit, "Escrow: not claimed");

        require(msg.sender == o.maker || msg.sender == o.taker, "Escrow: not party");

        // Fix: a TAKER must wait out the maker's confirm window before escalating
        // a claimed order; the maker faces no such gate on their own order.
        if (claimed && msg.sender == o.taker) {
            require(
                block.timestamp >= uint256(o.fiatClaimedAt) + uint256(CONFIRM_WINDOW),
                "Escrow: confirm window open"
            );
        }

        o.status = Status.Disputed;
        o.disputedAt = uint64(block.timestamp);
        emit DisputeRaised(orderId, msg.sender);
    }

    /// @notice Decide a dispute. Two authorized resolvers:
    ///  - the tranche's issuing Sarraf (arbiter RECOMPUTED from the tranche id,
    ///    so authority is cryptographically bound and unspoofable) — ANY time;
    ///  - the protocol {backstopArbiter} — ONLY after `disputedAt +
    ///    DISPUTE_TIMEOUT`, so an absent Sarraf can never permanently strand the
    ///    funds. This is a fallback human resolver, not an auto-default.
    /// `toTaker` releases the IOU to the taker; otherwise it refunds the maker.
    /// @dev CEI + reentrancy guarded; terminal on completion (no double-resolve).
    function resolve(uint256 orderId, bool toTaker) external nonReentrant {
        Order storage o = _orders[orderId];
        require(o.status == Status.Disputed, "Escrow: not disputed");

        address arbiter = address(uint160(o.trancheId));
        if (msg.sender == arbiter) {
            // Primary arbiter (the tranche Sarraf) — may resolve at any time.
        } else if (msg.sender == backstopArbiter) {
            require(
                block.timestamp >= uint256(o.disputedAt) + uint256(DISPUTE_TIMEOUT),
                "Escrow: backstop too early"
            );
        } else {
            revert("Escrow: not arbiter");
        }
        // Self-deal guard #3 (belt-and-braces; also enforced at create + fill).
        require(arbiter != o.maker && arbiter != o.taker, "Escrow: arbiter self-deal");

        address beneficiary;
        if (toTaker) {
            o.status = Status.ResolvedTaker;
            beneficiary = o.taker;
        } else {
            o.status = Status.ResolvedMaker;
            beneficiary = o.maker;
        }
        emit DisputeResolved(orderId, msg.sender, toTaker, beneficiary, o.usdtAmount);

        iou.safeTransferFrom(address(this), beneficiary, o.trancheId, o.usdtAmount, "");
    }

    // ------------------------------------------------------------------ views

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function statusOf(uint256 orderId) external view returns (Status) {
        return _orders[orderId].status;
    }

    /// @notice The arbiter for an order — the tranche's issuing Sarraf.
    function arbiterOf(uint256 orderId) external view returns (address) {
        return address(uint160(_orders[orderId].trancheId));
    }

    /// @notice Payment deadline (0 if not yet MATCHED).
    function paymentDeadline(uint256 orderId) external view returns (uint256) {
        Order storage o = _orders[orderId];
        if (o.matchedAt == 0) return 0;
        return uint256(o.matchedAt) + uint256(o.paymentWindow);
    }

    /// @notice Maker-confirm deadline (0 if not yet FIAT_CLAIMED). Also the
    /// earliest a TAKER may raise a dispute on a claimed order.
    function confirmDeadline(uint256 orderId) external view returns (uint256) {
        Order storage o = _orders[orderId];
        if (o.fiatClaimedAt == 0) return 0;
        return uint256(o.fiatClaimedAt) + uint256(CONFIRM_WINDOW);
    }

    /// @notice Earliest time the backstop arbiter may resolve (0 if not DISPUTED).
    function disputeDeadline(uint256 orderId) external view returns (uint256) {
        Order storage o = _orders[orderId];
        if (o.disputedAt == 0) return 0;
        return uint256(o.disputedAt) + uint256(DISPUTE_TIMEOUT);
    }

    // ------------------------------------------------------ ERC-1155 receiver

    /// @notice Accept IOU custody ONLY for a deposit this escrow just initiated
    /// (createOrder). Any other inbound transfer reverts, so no unaccounted IOU
    /// can be parked against the escrow.
    function onERC1155Received(address, address, uint256 id, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        require(msg.sender == address(iou), "Escrow: not iou");
        require(_expecting && id == _expectedId, "Escrow: unexpected deposit");
        return _ERC1155_RECEIVED;
    }

    /// @notice Batches are never used by this escrow — reject them outright.
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert("Escrow: no batch");
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x4e2312e0; // ERC-1155 TokenReceiver
    }
}
