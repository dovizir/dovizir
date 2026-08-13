// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReservePool, IIouToken, IMemberRegistry, ISarrafRegistry} from "dovizir-acceptance/interfaces/IDovizir.sol";
import {InsuranceFund} from "./InsuranceFund.sol";
import {SarrafRegistry} from "./SarrafRegistry.sol";
import {MemberRegistry} from "./MemberRegistry.sol";

interface IUsdt {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title ReservePool — tranche backing, funded-only issuance, redemption, migration
/// @notice Implements the frozen IReservePool:
///  - {deposit} is OPEN to any address (referee interpretation: certification
///    requires a 7-day deposit TWAB, so gating deposit would deadlock
///    bootstrap); every backing change checkpoints the SarrafRegistry TWAB;
///  - {issue} is certification-gated, only to the caller's OWN member, and
///    NEVER exceeds backing (M1 has no unfunded headroom — invariant (b));
///  - {redeem} is open to any holder: burns tranche IOU, charges the 90 bps
///    fee (rounds down) to the InsuranceFund, releases the full amount of
///    backing (net to the holder, fee to the fund);
///  - {migrate} moves a holder from a DE-certified sarraf's tranche to a
///    consenting certified one 1:1 (burn old, move backing attribution, mint
///    new) and rehomes the holder's membership when sponsored by `fromSarraf`.
contract ReservePool is IReservePool {
    uint256 public constant FEE_BPS = 90;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IUsdt public immutable usdt;
    IIouToken public immutable iou;
    MemberRegistry public immutable memberRegistry;
    SarrafRegistry public immutable sarrafRegistry;
    InsuranceFund public immutable insuranceFund;

    mapping(address => uint256) internal _backing;
    mapping(address => uint256) internal _outstanding;
    /// Spot sum of all tranche backing — the SarrafRegistry floor input.
    uint256 public totalDeposits;

    constructor(
        IUsdt usdt_,
        IIouToken iou_,
        MemberRegistry memberRegistry_,
        SarrafRegistry sarrafRegistry_,
        InsuranceFund insuranceFund_
    ) {
        require(
            address(usdt_) != address(0) && address(iou_) != address(0)
                && address(memberRegistry_) != address(0) && address(sarrafRegistry_) != address(0)
                && address(insuranceFund_) != address(0),
            "ReservePool: zero address"
        );
        usdt = usdt_;
        iou = iou_;
        memberRegistry = memberRegistry_;
        sarrafRegistry = sarrafRegistry_;
        insuranceFund = insuranceFund_;
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IReservePool
    function backingOf(address sarraf) external view returns (uint256) {
        return _backing[sarraf];
    }

    /// @inheritdoc IReservePool
    function outstandingOf(address sarraf) external view returns (uint256) {
        return _outstanding[sarraf];
    }

    /// @dev IDovizir.sol: tranche id = uint256(uint160(sarraf)).
    function trancheId(address sarraf) public pure returns (uint256) {
        return uint256(uint160(sarraf));
    }

    // -------------------------------------------------------------- mutations

    /// @inheritdoc IReservePool
    function deposit(uint256 usdtAmount) external {
        require(usdtAmount > 0, "ReservePool: zero amount");
        require(usdt.transferFrom(msg.sender, address(this), usdtAmount), "ReservePool: pull failed");
        _backing[msg.sender] += usdtAmount;
        totalDeposits += usdtAmount;
        sarrafRegistry.checkpoint(msg.sender, _backing[msg.sender]);
        emit Deposited(msg.sender, usdtAmount);
    }

    /// @inheritdoc IReservePool
    function issue(address to, uint256 amount) external {
        require(sarrafRegistry.isCertified(msg.sender), "ReservePool: caller not certified");
        require(memberRegistry.sarrafOf(to) == msg.sender, "ReservePool: not your member");
        require(amount > 0, "ReservePool: zero amount");
        uint256 newOutstanding = _outstanding[msg.sender] + amount;
        require(newOutstanding <= _backing[msg.sender], "ReservePool: unfunded issuance");
        _outstanding[msg.sender] = newOutstanding;
        iou.mint(to, trancheId(msg.sender), amount);
        emit Issued(msg.sender, to, amount);
    }

    /// @inheritdoc IReservePool
    function redeem(address sarraf, uint256 amount) external {
        require(amount > 0, "ReservePool: zero amount");
        // Burn reverts if the caller's tranche balance is insufficient.
        iou.burn(msg.sender, trancheId(sarraf), amount);
        _outstanding[sarraf] -= amount;
        _backing[sarraf] -= amount;
        totalDeposits -= amount;
        sarrafRegistry.checkpoint(sarraf, _backing[sarraf]);

        uint256 fee = (amount * FEE_BPS) / BPS_DENOMINATOR; // rounds DOWN (frozen)
        if (fee > 0) {
            require(usdt.transfer(address(insuranceFund), fee), "ReservePool: fee transfer failed");
        }
        insuranceFund.recordFee(fee);
        require(usdt.transfer(msg.sender, amount - fee), "ReservePool: payout failed");
        emit Redeemed(sarraf, msg.sender, amount, fee);
    }

    /// @inheritdoc IReservePool
    function migrate(address fromSarraf, address toSarraf, uint256 amount) external {
        require(amount > 0, "ReservePool: zero amount");
        require(!sarrafRegistry.isCertified(fromSarraf), "ReservePool: fromSarraf still certified");
        require(sarrafRegistry.isCertified(toSarraf), "ReservePool: toSarraf not certified");
        require(sarrafRegistry.isAccepting(toSarraf), "ReservePool: toSarraf not accepting");
        // M1 note: with funded-only issuance the from-tranche can never be
        // impaired through the public surface (backing >= outstanding always),
        // so the interface's "from-tranche impaired" revert is unreachable.

        // Burn old-tranche IOU (reverts on insufficient holder balance).
        iou.burn(msg.sender, trancheId(fromSarraf), amount);
        _outstanding[fromSarraf] -= amount;
        _backing[fromSarraf] -= amount;
        sarrafRegistry.checkpoint(fromSarraf, _backing[fromSarraf]);

        // Move backing attribution and mint the new tranche 1:1.
        _backing[toSarraf] += amount;
        _outstanding[toSarraf] += amount;
        sarrafRegistry.checkpoint(toSarraf, _backing[toSarraf]);
        iou.mint(msg.sender, trancheId(toSarraf), amount);

        // Open-acceptance rehoming: if the holder is a member sponsored by the
        // failed sarraf, they re-home to the accepting one.
        if (memberRegistry.sarrafOf(msg.sender) == fromSarraf) {
            memberRegistry.rehome(msg.sender, toSarraf);
        }
        emit Migrated(msg.sender, fromSarraf, toSarraf, amount);
    }
}
