// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReservePool, IIouToken} from "../../../acceptance/src/interfaces/IDovizir.sol";
import {IMockUsdt} from "../../../acceptance/src/interfaces/IAcceptanceDeployer.sol";
import {SarrafRegistry} from "./SarrafRegistry.sol";
import {InsuranceFund} from "./InsuranceFund.sol";

contract ReservePool is IReservePool {
    uint256 internal constant FEE_BPS = 90;

    IMockUsdt public immutable usdt;
    IIouToken public immutable iouToken;
    SarrafRegistry public immutable sarrafRegistry;
    InsuranceFund public immutable insuranceFund;

    mapping(address => uint256) public override backingOf;
    mapping(address => uint256) public override outstandingOf;

    constructor(address usdt_, address iouToken_, address sarrafRegistry_, address insuranceFund_) {
        usdt = IMockUsdt(usdt_);
        iouToken = IIouToken(iouToken_);
        sarrafRegistry = SarrafRegistry(sarrafRegistry_);
        insuranceFund = InsuranceFund(insuranceFund_);
    }

    function _id(address sarraf) internal pure returns (uint256) {
        return uint256(uint160(sarraf));
    }

    /// OPEN to any address — certification requires a deposit TWAB, so
    /// gating deposit() on certification would deadlock bootstrap
    /// (adjudicated 2026-08-13, see acceptance/README.md).
    function deposit(uint256 usdtAmount) external override {
        require(usdt.transferFrom(msg.sender, address(this), usdtAmount), "ReservePool: transfer failed");
        backingOf[msg.sender] += usdtAmount;
        sarrafRegistry.recordDeposit(msg.sender, backingOf[msg.sender]);
        emit Deposited(msg.sender, usdtAmount);
    }

    function issue(address to, uint256 amount) external override {
        require(sarrafRegistry.isCertified(msg.sender), "ReservePool: not certified");
        require(backingOf[msg.sender] >= outstandingOf[msg.sender] + amount, "ReservePool: unfunded");
        outstandingOf[msg.sender] += amount;
        iouToken.mint(to, _id(msg.sender), amount);
        emit Issued(msg.sender, to, amount);
    }

    function redeem(address sarraf, uint256 amount) external override {
        iouToken.burn(msg.sender, _id(sarraf), amount);
        uint256 fee = (amount * FEE_BPS) / 10_000;
        uint256 net = amount - fee;
        outstandingOf[sarraf] -= amount;
        backingOf[sarraf] -= net;
        if (fee > 0) {
            require(usdt.transfer(address(insuranceFund), fee), "ReservePool: fee transfer failed");
            insuranceFund.recordFee(fee);
        }
        require(usdt.transfer(msg.sender, net), "ReservePool: redeem transfer failed");
        emit Redeemed(sarraf, msg.sender, amount, fee);
    }

    function migrate(address fromSarraf, address toSarraf, uint256 amount) external override {
        iouToken.burn(msg.sender, _id(fromSarraf), amount);
        outstandingOf[fromSarraf] -= amount;
        backingOf[fromSarraf] -= amount;
        backingOf[toSarraf] += amount;
        outstandingOf[toSarraf] += amount;
        iouToken.mint(msg.sender, _id(toSarraf), amount);
        emit Migrated(msg.sender, fromSarraf, toSarraf, amount);
    }
}
