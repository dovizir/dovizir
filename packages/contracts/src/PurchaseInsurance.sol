// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUsdt} from "./ReservePool.sol";
import {SarrafRegistry} from "./SarrafRegistry.sol";

/// @title PurchaseInsurance — bonded shops, earned premiums, tranched losses
/// @notice Implements docs/design/purchase-insurance.md. Distinct from
/// {InsuranceFund}, which owns the redemption fee and offline-note double-spend
/// claims and whose reserve accounting is pinned by the referee suite. This
/// contract owns the PURCHASE risk pool only:
///
///  - a sarraf registers a shop, which posts a USDT bond; exposure caps derive
///    from `bond x trust` (secured-card model, graduating with clean history);
///  - each purchase carries a premium paid by the SELLER (the buyer pays
///    nothing), split 50/50 between the issuing sarraf's own layer and the
///    maintainer layer. Layers are PER-SARRAF, not pooled: a sarraf's cushion
///    is their own and slashable;
///  - a premium is UNEARNED for the coverage window and becomes EARNED when the
///    window passes undisputed, or immediately when the buyer confirms receipt;
///  - an upheld non-delivery claim is paid by a SEQUENTIAL waterfall — the
///    shop's bond first (closest to the fault), then the issuing sarraf's
///    layer, then the maintainer layer as senior backstop.
contract PurchaseInsurance {
    // ----------------------------------------------------------- constants

    /// Premium charged to the seller, in basis points of the purchase.
    uint16 public constant PREMIUM_BPS = 90; // 0.9%
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// Card-network chargeback yardstick: undisputed for this long => earned.
    uint64 public constant COVERAGE_WINDOW = 120 days;

    /// Solvency cushion each layer must retain against live covered exposure
    /// (insurance reserve-requirement analog). 1_000 bps == 10%.
    uint16 public constant RESERVE_RATIO_BPS = 1_000;

    /// Trust a shop falls back to when a non-delivery claim is proven against
    /// it: fully secured, limit == bond. It must earn graduation again.
    uint32 public constant BASELINE_TRUST_BPS = 10_000;

    /// How long a buyer has to escalate a rejected claim to the backstop.
    uint64 public constant APPEAL_WINDOW = 14 days;

    // --------------------------------------------------------------- types

    struct Shop {
        address sarraf; //        issuing sarraf who underwrote this shop
        uint256 bond; //          USDT posted as first-loss capital
        uint32 trustBps; //       multiplier over the bond (10_000 == 1.0x)
        bool registered;
        uint256 dailyVolumeCap; // 0 == unenforced (card analog: velocity cap)
        uint256 soldToday; //     rolling total inside the current day
        uint64 dayStart; //       timestamp the current day window opened
    }

    enum Status {
        NONE,
        COVERED, //    inside the window, premium unearned
        SETTLED, //    earned: window passed or buyer confirmed
        DISPUTED, //   claim filed, awaiting a ruling
        REFUNDED, //   claim upheld and paid from the waterfall
        REJECTED, //   claim denied; still appealable to the backstop
        APPEALED //    escalated; awaiting the backstop's ruling
    }

    struct Purchase {
        address shop;
        address buyer;
        address sarraf; //     pinned at purchase time; survives shop re-underwriting
        uint256 amount;
        uint256 premium;
        uint64 coveredUntil;
        uint64 appealUntil; //  set when a claim is rejected
        Status status;
    }

    // --------------------------------------------------------------- state

    IUsdt public immutable usdt;
    SarrafRegistry public immutable sarrafRegistry;
    /// Senior backstop layer, and the party that disciplines sloppy sarrafs.
    address public immutable maintainer;
    /// Overseeing body that rules on disputes. Never the earning sarraf.
    address public immutable adjudicator;
    /// Neutral appeal authority. Hears escalations of rejected claims; the
    /// adjudicator cannot hear an appeal of its own ruling.
    address public immutable backstopArbiter;

    mapping(address => Shop) internal _shops;

    uint256 public nextPurchaseId;
    mapping(uint256 => Purchase) internal _purchases;

    /// Live covered exposure per shop: locks its bond while claims can land.
    mapping(address => uint256) internal _shopExposure;

    /// Per-sarraf premium layers (their own cushion, slashable).
    mapping(address => uint256) public unearnedOf;
    mapping(address => uint256) public earnedOf;
    /// Sum of live covered purchase value attributable to a sarraf's layer.
    mapping(address => uint256) public outstandingExposureOf;

    /// Underwriting failures: incremented when a loss pierces a shop's bond
    /// and reaches the sarraf's own layer. Basis for maintainer discipline.
    mapping(address => uint256) public strikesOf;

    /// Senior maintainer layer.
    uint256 public unearnedMaintainer;
    uint256 public earnedMaintainer;
    uint256 public outstandingExposureMaintainer;

    // -------------------------------------------------------------- events

    event ShopRegistered(address indexed shop, address indexed sarraf, uint256 bond, uint32 trustBps);
    event PurchaseRecorded(
        uint256 indexed purchaseId,
        address indexed shop,
        address indexed buyer,
        uint256 amount,
        uint256 premium,
        uint64 coveredUntil
    );
    event PremiumEarned(uint256 indexed purchaseId, address indexed sarraf, uint256 premium);
    event ReceiptConfirmed(uint256 indexed purchaseId, address indexed buyer);
    event ClaimFiled(uint256 indexed purchaseId, address indexed buyer, uint256 amount);
    event ClaimRuled(uint256 indexed purchaseId, bool upheld, uint256 paid);
    event LossAbsorbed(
        address indexed shop, uint256 fromBond, uint256 fromSarraf, uint256 fromMaintainer
    );
    event Withdrawn(address indexed layer, uint256 amount);
    event MaintainerFunded(address indexed from, uint256 amount);
    event DailyVolumeCapSet(address indexed shop, uint256 cap);
    event TrustSet(address indexed shop, uint32 trustBps);
    event BondToppedUp(address indexed shop, address indexed from, uint256 amount);
    event BondReleased(address indexed shop, address indexed to, uint256 amount);
    event Appealed(uint256 indexed purchaseId, address indexed buyer);
    event AppealRuled(uint256 indexed purchaseId, bool upheld);
    event SarrafStrike(address indexed sarraf, uint256 strikes);
    event SarrafPenalized(address indexed sarraf, uint256 amount);

    constructor(
        IUsdt usdt_,
        SarrafRegistry sarrafRegistry_,
        address maintainer_,
        address adjudicator_,
        address backstopArbiter_
    ) {
        require(address(usdt_) != address(0), "PI: zero usdt");
        require(maintainer_ != address(0), "PI: zero maintainer");
        require(adjudicator_ != address(0), "PI: zero adjudicator");
        require(backstopArbiter_ != address(0), "PI: zero backstop");
        require(backstopArbiter_ != adjudicator_, "PI: backstop must be independent");
        usdt = usdt_;
        sarrafRegistry = sarrafRegistry_;
        maintainer = maintainer_;
        adjudicator = adjudicator_;
        backstopArbiter = backstopArbiter_;
    }

    // --------------------------------------------------------------- views

    function bondOf(address shop) external view returns (uint256) {
        return _shops[shop].bond;
    }

    function sarrafOf(address shop) external view returns (address) {
        return _shops[shop].sarraf;
    }

    function trustBpsOf(address shop) external view returns (uint32) {
        return _shops[shop].trustBps;
    }

    /// @notice Ceiling on a single invoice: `bond x trust`. Secured-card model —
    /// the limit starts at the deposit and graduates with clean history.
    function maxExposure(address shop) public view returns (uint256) {
        Shop storage s = _shops[shop];
        return (s.bond * s.trustBps) / BPS_DENOMINATOR;
    }

    function dailyVolumeCapOf(address shop) external view returns (uint256) {
        return _shops[shop].dailyVolumeCap;
    }

    /// @notice Volume sold inside the current rolling day, 0 once it has rolled.
    function soldTodayOf(address shop) external view returns (uint256) {
        Shop storage s = _shops[shop];
        if (block.timestamp >= s.dayStart + 1 days) return 0;
        return s.soldToday;
    }

    /// @notice Live covered exposure attributable to one shop -- what its bond
    /// is currently standing behind.
    function shopExposureOf(address shop) external view returns (uint256) {
        return _shopExposure[shop];
    }

    function purchaseOf(uint256 purchaseId) external view returns (Purchase memory) {
        return _purchases[purchaseId];
    }

    // ------------------------------------------------------ shop lifecycle

    /// @notice A certified sarraf underwrites `shop`, escrowing its bond here.
    function registerShop(address shop, uint256 bond, uint32 trustBps) external {
        require(sarrafRegistry.isCertified(msg.sender), "PI: not certified");
        require(shop != address(0), "PI: zero shop");
        require(bond > 0, "PI: zero bond");
        require(trustBps > 0, "PI: zero trust");
        require(!_shops[shop].registered, "PI: already registered");

        _shops[shop] = Shop({
            sarraf: msg.sender,
            bond: bond,
            trustBps: trustBps,
            registered: true,
            dailyVolumeCap: 0,
            soldToday: 0,
            dayStart: uint64(block.timestamp)
        });

        require(usdt.transferFrom(msg.sender, address(this), bond), "PI: bond transfer failed");
        emit ShopRegistered(shop, msg.sender, bond, trustBps);
    }

    /// @notice Velocity cap (card analog: max sales per day). 0 disables it.
    function setDailyVolumeCap(address shop, uint256 cap) external {
        _onlyUnderwriter(shop);
        _shops[shop].dailyVolumeCap = cap;
        emit DailyVolumeCapSet(shop, cap);
    }

    /// @notice Graduation: raise (or cut) a shop's multiplier over its bond.
    function setTrust(address shop, uint32 trustBps) external {
        _onlyUnderwriter(shop);
        require(trustBps > 0, "PI: zero trust");
        _shops[shop].trustBps = trustBps;
        emit TrustSet(shop, trustBps);
    }

    /// @notice Add first-loss capital. Open to anyone -- the shop typically
    /// funds its own bond, and either party may reinforce it after a slash.
    function topUpBond(address shop, uint256 amount) external {
        require(_shops[shop].registered, "PI: shop not registered");
        require(amount > 0, "PI: zero amount");
        _shops[shop].bond += amount;
        require(usdt.transferFrom(msg.sender, address(this), amount), "PI: bond transfer failed");
        emit BondToppedUp(shop, msg.sender, amount);
    }

    /// @notice Return bond to the underwriting sarraf. Locked while ANY covered
    /// purchase is still live: the bond is the first-loss layer standing behind
    /// exactly those purchases, so it cannot walk before their windows close.
    function releaseBond(address shop, uint256 amount) external {
        _onlyUnderwriter(shop);
        require(amount > 0, "PI: zero amount");
        require(_shopExposure[shop] == 0, "PI: bond locked");
        Shop storage s = _shops[shop];
        require(amount <= s.bond, "PI: over bond");
        s.bond -= amount;
        require(usdt.transfer(msg.sender, amount), "PI: release failed");
        emit BondReleased(shop, msg.sender, amount);
    }

    function _onlyUnderwriter(address shop) internal view {
        require(_shops[shop].registered, "PI: shop not registered");
        require(msg.sender == _shops[shop].sarraf, "PI: not the underwriter");
    }

    // ----------------------------------------------------------- purchases

    /// @notice Called by the shop when a covered purchase settles. The premium
    /// is pulled from the SELLER; the buyer pays nothing.
    function recordPurchase(address buyer, uint256 amount) external returns (uint256 purchaseId) {
        Shop storage s = _shops[msg.sender];
        require(s.registered, "PI: shop not registered");
        require(buyer != address(0), "PI: zero buyer");
        require(amount > 0, "PI: zero amount");
        require(amount <= maxExposure(msg.sender), "PI: over max invoice");

        // Rolling daily window: reset the counter once a full day has passed.
        if (block.timestamp >= s.dayStart + 1 days) {
            s.dayStart = uint64(block.timestamp);
            s.soldToday = 0;
        }
        s.soldToday += amount;
        if (s.dailyVolumeCap > 0) {
            require(s.soldToday <= s.dailyVolumeCap, "PI: over daily cap");
        }
        _shopExposure[msg.sender] += amount;

        uint256 premium = (amount * PREMIUM_BPS) / BPS_DENOMINATOR;
        uint256 half = premium / 2;

        address sarraf = s.sarraf;
        // Odd wei goes to the sarraf's layer, mirroring InsuranceFund's frozen
        // rounding rule (maintenance takes the floor half).
        unearnedOf[sarraf] += premium - half;
        unearnedMaintainer += half;

        outstandingExposureOf[sarraf] += amount;
        outstandingExposureMaintainer += amount;

        purchaseId = ++nextPurchaseId;
        uint64 coveredUntil = uint64(block.timestamp) + COVERAGE_WINDOW;
        _purchases[purchaseId] = Purchase({
            shop: msg.sender,
            buyer: buyer,
            sarraf: sarraf,
            amount: amount,
            premium: premium,
            coveredUntil: coveredUntil,
            appealUntil: 0,
            status: Status.COVERED
        });

        require(usdt.transferFrom(msg.sender, address(this), premium), "PI: premium failed");
        emit PurchaseRecorded(purchaseId, msg.sender, buyer, amount, premium, coveredUntil);
    }

    // ------------------------------------------------------------- earning

    /// @notice Coverage lapsed undisputed: the premium becomes the layers' own.
    /// Permissionless — the passage of time is the only precondition.
    function earn(uint256 purchaseId) external {
        Purchase storage p = _purchases[purchaseId];
        require(p.status == Status.COVERED, "PI: not covered");
        require(block.timestamp > p.coveredUntil, "PI: still covered");
        _settle(p);
        emit PremiumEarned(purchaseId, p.sarraf, p.premium);
    }

    /// @notice The buyer confirms delivery, ending coverage early. This is the
    /// selling point over cards: a card payment stays reversible for months,
    /// this is final the moment the buyer confirms.
    function confirmReceipt(uint256 purchaseId) external {
        Purchase storage p = _purchases[purchaseId];
        require(p.status == Status.COVERED, "PI: not covered");
        require(msg.sender == p.buyer, "PI: not buyer");
        _settle(p);
        emit ReceiptConfirmed(purchaseId, msg.sender);
    }

    /// Move this purchase's premium from unearned to earned and release the
    /// exposure it was holding a cushion against.
    function _settle(Purchase storage p) internal {
        uint256 half = p.premium / 2;
        uint256 sarrafCut = p.premium - half;

        unearnedOf[p.sarraf] -= sarrafCut;
        earnedOf[p.sarraf] += sarrafCut;
        unearnedMaintainer -= half;
        earnedMaintainer += half;

        outstandingExposureOf[p.sarraf] -= p.amount;
        outstandingExposureMaintainer -= p.amount;
        _shopExposure[p.shop] -= p.amount;

        p.status = Status.SETTLED;
    }

    // -------------------------------------------------------------- claims

    /// @notice The buyer reports goods not delivered, inside the window.
    function fileClaim(uint256 purchaseId) external {
        Purchase storage p = _purchases[purchaseId];
        require(p.status == Status.COVERED, "PI: not covered");
        require(msg.sender == p.buyer, "PI: not buyer");
        require(block.timestamp <= p.coveredUntil, "PI: coverage expired");
        p.status = Status.DISPUTED;
        emit ClaimFiled(purchaseId, msg.sender, p.amount);
    }

    /// @notice The overseeing body rules. The sarraf who earns the premium on
    /// this sale is recused — they never judge their own case — and the payout
    /// comes from the waterfall, never from the ruler's pocket, so the ruler is
    /// financially indifferent to the outcome.
    function ruleClaim(uint256 purchaseId, bool upheld) external {
        Purchase storage p = _purchases[purchaseId];
        require(p.status == Status.DISPUTED, "PI: not disputed");
        require(msg.sender != p.sarraf, "PI: recused");
        require(msg.sender == adjudicator, "PI: not adjudicator");

        if (!upheld) {
            // No loss: the premium is earned and coverage closes -- but the
            // buyer may still escalate to the neutral backstop.
            _settle(p);
            p.status = Status.REJECTED;
            p.appealUntil = uint64(block.timestamp) + APPEAL_WINDOW;
            emit ClaimRuled(purchaseId, false, 0);
            return;
        }

        // Release the cushion this purchase held before absorbing the loss: the
        // exposure has crystallised into an actual paid claim.
        outstandingExposureOf[p.sarraf] -= p.amount;
        outstandingExposureMaintainer -= p.amount;
        _shopExposure[p.shop] -= p.amount;

        _uphold(p);
        emit ClaimRuled(purchaseId, true, p.amount);
    }

    /// Absorb the loss, discipline the shop, and make the buyer whole.
    function _uphold(Purchase storage p) internal {
        _payWaterfall(p);
        // Discipline: a proven non-delivery resets the shop to fully secured.
        // It must earn graduation back on clean history.
        _shops[p.shop].trustBps = BASELINE_TRUST_BPS;
        emit TrustSet(p.shop, BASELINE_TRUST_BPS);
        p.status = Status.REFUNDED;
        require(usdt.transfer(p.buyer, p.amount), "PI: refund failed");
    }

    // ------------------------------------------------------------- appeals

    /// @notice Escalate a rejected claim to the neutral backstop. This is the
    /// customer-facing promise that the ruling is not the last word.
    function appeal(uint256 purchaseId) external {
        Purchase storage p = _purchases[purchaseId];
        require(p.status == Status.REJECTED, "PI: not rejected");
        require(msg.sender == p.buyer, "PI: not buyer");
        require(block.timestamp <= p.appealUntil, "PI: appeal window closed");
        p.status = Status.APPEALED;
        emit Appealed(purchaseId, msg.sender);
    }

    /// @notice The backstop's ruling is final. Overturning a rejection pays the
    /// buyer from the same waterfall -- never from the arbiter's pocket.
    function ruleAppeal(uint256 purchaseId, bool upheld) external {
        Purchase storage p = _purchases[purchaseId];
        require(p.status == Status.APPEALED, "PI: not appealed");
        require(msg.sender == backstopArbiter, "PI: not backstop");
        require(msg.sender != p.sarraf, "PI: recused");

        if (upheld) {
            _uphold(p);
        } else {
            p.status = Status.SETTLED; // the rejection stands, finally
        }
        emit AppealRuled(purchaseId, upheld);
    }

    /// Sequential, junior to senior: the shop's bond (closest to the fault),
    /// then the issuing sarraf's own layer, then the maintainer as backstop.
    /// Each sarraf's cushion is their own — a careless sarraf's losses never
    /// reach a careful one's layer.
    function _payWaterfall(Purchase storage p) internal {
        uint256 remaining = p.amount;

        // 1. shop bond
        Shop storage s = _shops[p.shop];
        uint256 fromBond = s.bond < remaining ? s.bond : remaining;
        s.bond -= fromBond;
        remaining -= fromBond;
        if (remaining == 0) {
            emit LossAbsorbed(p.shop, fromBond, 0, 0);
            return;
        }

        // 2. the issuing sarraf's layer — unearned first, then earned.
        uint256 fromSarraf = _drain(p.sarraf, remaining);
        remaining -= fromSarraf;
        if (fromSarraf > 0) {
            // The bond did not hold: this is an underwriting failure.
            strikesOf[p.sarraf] += 1;
            emit SarrafStrike(p.sarraf, strikesOf[p.sarraf]);
        }
        if (remaining == 0) {
            emit LossAbsorbed(p.shop, fromBond, fromSarraf, 0);
            return;
        }

        // 3. maintainer backstop — unearned first, then earned.
        uint256 fromMaintainer;
        uint256 mu = unearnedMaintainer;
        uint256 takeU = mu < remaining ? mu : remaining;
        unearnedMaintainer = mu - takeU;
        remaining -= takeU;
        fromMaintainer = takeU;

        if (remaining > 0) {
            uint256 me = earnedMaintainer;
            require(me >= remaining, "PI: fund insolvent");
            earnedMaintainer = me - remaining;
            fromMaintainer += remaining;
            remaining = 0;
        }
        emit LossAbsorbed(p.shop, fromBond, fromSarraf, fromMaintainer);
    }

    /// Take up to `want` from a sarraf's layer, unearned before earned.
    function _drain(address sarraf, uint256 want) internal returns (uint256 taken) {
        uint256 u = unearnedOf[sarraf];
        uint256 takeU = u < want ? u : want;
        unearnedOf[sarraf] = u - takeU;
        taken = takeU;

        uint256 rest = want - takeU;
        if (rest == 0) return taken;

        uint256 e = earnedOf[sarraf];
        uint256 takeE = e < rest ? e : rest;
        earnedOf[sarraf] = e - takeE;
        taken += takeE;
    }

    // ------------------------------------------------ backstop capitalisation

    /// @notice Capitalise the senior layer beyond accrued premiums. A real
    /// backstop holds capital, not only the premiums it has collected: without
    /// this, a loss larger than every layer would leave an upheld claim
    /// unpayable and the dispute stuck open. Funded capital counts as earned
    /// (it is not premium awaiting a coverage window), and the cushion rule
    /// still governs what the maintainer may take back out.
    function fundMaintainer(uint256 amount) external {
        require(amount > 0, "PI: zero amount");
        earnedMaintainer += amount;
        require(usdt.transferFrom(msg.sender, address(this), amount), "PI: funding failed");
        emit MaintainerFunded(msg.sender, amount);
    }

    /// @notice The maintainer disciplines a sarraf whose underwriting failed:
    /// a penalty from their EARNED premiums into the senior layer (reinsurer
    /// disciplining a sloppy primary insurer). Unearned premium is out of
    /// reach -- it is still owed to coverage. De-certification itself lives in
    /// the SarrafRegistry; this is the monetary half of the chain.
    function penalizeSarraf(address sarraf, uint256 amount) external {
        require(msg.sender == maintainer, "PI: not maintainer");
        require(amount > 0, "PI: zero amount");
        require(amount <= earnedOf[sarraf], "PI: over earned");
        earnedOf[sarraf] -= amount;
        earnedMaintainer += amount;
        emit SarrafPenalized(sarraf, amount);
    }

    // ---------------------------------------------------------- withdrawal

    /// @notice Profit is the earned surplus above the required cushion — the
    /// "remainder taken without risk". Unearned premium is never withdrawable,
    /// which also removes the short-term incentive to deny a claim: there is no
    /// cash to protect while a purchase is still inside its window.
    function withdrawableOf(address sarraf) public view returns (uint256) {
        uint256 cushion =
            (outstandingExposureOf[sarraf] * RESERVE_RATIO_BPS) / BPS_DENOMINATOR;
        uint256 e = earnedOf[sarraf];
        return e > cushion ? e - cushion : 0;
    }

    function withdrawableMaintainer() public view returns (uint256) {
        uint256 cushion =
            (outstandingExposureMaintainer * RESERVE_RATIO_BPS) / BPS_DENOMINATOR;
        return earnedMaintainer > cushion ? earnedMaintainer - cushion : 0;
    }

    function withdraw(uint256 amount) external {
        require(amount > 0, "PI: zero amount");
        require(amount <= withdrawableOf(msg.sender), "PI: over withdrawable");
        earnedOf[msg.sender] -= amount;
        require(usdt.transfer(msg.sender, amount), "PI: withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }

    function withdrawMaintainer(uint256 amount) external {
        require(msg.sender == maintainer, "PI: not maintainer");
        require(amount > 0, "PI: zero amount");
        require(amount <= withdrawableMaintainer(), "PI: over withdrawable");
        earnedMaintainer -= amount;
        require(usdt.transfer(msg.sender, amount), "PI: withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }
}
