// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IIouToken,
    IMemberRegistry,
    IReservePool,
    IInsuranceFund,
    ISarrafRegistry,
    INoteVault
} from "./IDovizir.sol";

/// @title IAcceptanceDeployer — the hook each experiment arm implements (FROZEN)
/// @notice The referee suite (docs/experiment/PROTOCOL.md §3) instantiates an
/// arm's deployer via `deployCode` and calls `deploy()` once per test in
/// `setUp()`. The deployer must return a FRESH, fully wired system every call:
/// all cross-contract references configured (pool may mint/burn IOU, vault may
/// call fund.payClaim, migrate flow may rehome, fees route to the fund, etc.).
///
/// Requirements the suite relies on:
///  - `usdt` is a mock ERC-20 with 6 decimals and an OPEN `mint(address,uint256)`
///    so tests can fund arbitrary addresses.
///  - All contracts read `block.timestamp` live (tests drive time with vm.warp);
///    no reliance on wall-clock offsets captured before the tests warp.
///  - `deploy()` must not depend on msg.sender being anything special beyond
///    the deployer contract itself.

/// @dev Minimal ERC-20 surface of the mock USDT, plus the open test mint.
interface IMockUsdt {
    function decimals() external view returns (uint8); // MUST return 6
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// Open mint for test funding: callable by ANY address.
    function mint(address to, uint256 amount) external;
}

/// @dev ERC-1155 core surface the suite needs on the IOU token (IIouToken
/// assumes ERC-1155 compliance; these are the calls the referee makes).
interface IErc1155Core {
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function setApprovalForAll(address operator, bool approved) external;
    function isApprovedForAll(address account, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}

struct DovizirSystem {
    IMockUsdt usdt;
    IIouToken iouToken;
    IMemberRegistry memberRegistry;
    IReservePool reservePool;
    IInsuranceFund insuranceFund;
    ISarrafRegistry sarrafRegistry;
    INoteVault noteVault;
}

interface IAcceptanceDeployer {
    /// Deploy and wire a fresh system. Called once per test (from setUp).
    function deploy() external returns (DovizirSystem memory system);
}
