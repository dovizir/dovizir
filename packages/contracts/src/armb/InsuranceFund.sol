// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInsuranceFund} from "../../../acceptance/src/interfaces/IDovizir.sol";
import {IMockUsdt} from "../../../acceptance/src/interfaces/IAcceptanceDeployer.sol";

contract InsuranceFund is IInsuranceFund {
    IMockUsdt public immutable usdt;
    address private immutable _deployer;
    bool private _wired;
    address public pool;
    address public vault;

    uint256 public override overseeingShare;
    uint256 public override maintenanceShare;

    constructor(address usdt_) {
        usdt = IMockUsdt(usdt_);
        _deployer = msg.sender;
    }

    function setAuthorized(address pool_, address vault_) external {
        require(msg.sender == _deployer && !_wired, "InsuranceFund: wiring locked");
        _wired = true;
        pool = pool_;
        vault = vault_;
    }

    function totalReserves() external view override returns (uint256) {
        return overseeingShare + maintenanceShare;
    }

    /// Called by the pool after it transfers the fee in; splits 50/50 with
    /// the odd wei going to the overseeing share (frozen spec, README.md).
    function recordFee(uint256 amount) external {
        require(msg.sender == pool, "InsuranceFund: not authorized");
        uint256 half = amount / 2;
        maintenanceShare += half;
        overseeingShare += amount - half;
        emit FeeReceived(amount);
    }

    function payClaim(address victim, uint256 amount) external override {
        require(msg.sender == vault, "InsuranceFund: not authorized");
        require(overseeingShare >= amount, "InsuranceFund: insufficient reserve");
        overseeingShare -= amount;
        require(usdt.transfer(victim, amount), "InsuranceFund: payout failed");
    }
}
