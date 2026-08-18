// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMockUsdt} from "../../../acceptance/src/interfaces/IAcceptanceDeployer.sol";

/// @dev Mock ERC-20 with 6 decimals and an open mint, per
/// IAcceptanceDeployer.sol's requirements on `usdt`.
contract MockUsdt is IMockUsdt {
    uint8 public override decimals = 6;
    uint256 public override totalSupply;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    function mint(address to, uint256 amount) external override {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "MockUsdt: allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "MockUsdt: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
