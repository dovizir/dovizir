// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInsuranceFund} from "dovizir-acceptance/interfaces/IDovizir.sol";

interface IUsdtLike {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title InsuranceFund — redemption-fee reserves with 50/50 split bookkeeping
/// @notice Implements the frozen IInsuranceFund:
///  - receives the 90 bps redemption fee from the ReservePool (USDT arrives by
///    transfer; the pool then calls {recordFee}). Frozen rounding rule: for an
///    odd-wei fee, maintenanceShare += fee/2 (rounds down) and overseeingShare
///    gets the extra wei;
///  - `totalReserves() == overseeingShare() + maintenanceShare()` at all times
///    (invariant (c));
///  - {payClaim} pays a double-spend victim in USDT, NoteVault-only.
///
/// Seizure-excess bookkeeping (adjudication 2026-08-13, unasserted in round 1):
/// double-spend seizure excess arrives as carver-tranche IOU (ERC-1155) held
/// by this contract and is recorded under the same 50/50 split in the separate
/// `seizedIou*` buckets. It is deliberately NOT part of `totalReserves()`: the
/// referee pins `totalReserves()` as fee-USDT accounting (the double-spend
/// acceptance test asserts reserves are untouched when seizure covers the
/// victim), so IOU-denominated seizure value is tracked in parallel rather
/// than commingled.
contract InsuranceFund is IInsuranceFund {
    IUsdtLike public immutable usdt;
    address public immutable deployer;
    address public reservePool; // set once via init
    address public noteVault; // set once via init

    uint256 internal _overseeingShare;
    uint256 internal _maintenanceShare;

    /// 50/50 split of double-spend seizure excess, denominated in IOU units.
    uint256 public seizedIouOverseeingShare;
    uint256 public seizedIouMaintenanceShare;

    event SeizureExcessReceived(uint256 amount);

    constructor(IUsdtLike usdt_) {
        require(address(usdt_) != address(0), "InsuranceFund: zero usdt");
        usdt = usdt_;
        deployer = msg.sender;
    }

    function init(address reservePool_, address noteVault_) external {
        require(msg.sender == deployer, "InsuranceFund: only deployer");
        require(reservePool == address(0) && noteVault == address(0), "InsuranceFund: already initialized");
        require(reservePool_ != address(0) && noteVault_ != address(0), "InsuranceFund: zero address");
        reservePool = reservePool_;
        noteVault = noteVault_;
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IInsuranceFund
    function totalReserves() external view returns (uint256) {
        return _overseeingShare + _maintenanceShare;
    }

    /// @inheritdoc IInsuranceFund
    function overseeingShare() external view returns (uint256) {
        return _overseeingShare;
    }

    /// @inheritdoc IInsuranceFund
    function maintenanceShare() external view returns (uint256) {
        return _maintenanceShare;
    }

    // ------------------------------------------------------------------- fees

    /// @notice Called by the ReservePool after transferring `fee` USDT here.
    /// Frozen rounding: maintenance takes fee/2 (down), overseeing the rest.
    function recordFee(uint256 fee) external {
        require(msg.sender == reservePool, "InsuranceFund: only pool");
        uint256 half = fee / 2;
        _maintenanceShare += half;
        _overseeingShare += fee - half;
        emit FeeReceived(fee);
    }

    // ----------------------------------------------------------------- claims

    /// @inheritdoc IInsuranceFund
    function payClaim(address victim, uint256 amount) external {
        _payClaim(victim, amount, bytes32(0));
    }

    /// @notice Serial-attributed claim used by the NoteVault's double-spend
    /// path so ClaimPaid carries the convicted note serial.
    function payClaimForSerial(address victim, uint256 amount, bytes32 noteSerial) external {
        _payClaim(victim, amount, noteSerial);
    }

    function _payClaim(address victim, uint256 amount, bytes32 noteSerial) internal {
        require(msg.sender == noteVault, "InsuranceFund: only vault");
        require(victim != address(0), "InsuranceFund: zero victim");
        uint256 m = _maintenanceShare;
        uint256 o = _overseeingShare;
        require(amount <= m + o, "InsuranceFund: insufficient reserves");
        // Draw the claim half/half, cascading any bucket shortfall to the other.
        uint256 takeM = amount / 2;
        if (takeM > m) takeM = m;
        uint256 takeO = amount - takeM;
        if (takeO > o) {
            takeM += takeO - o;
            takeO = o;
        }
        _maintenanceShare = m - takeM;
        _overseeingShare = o - takeO;
        require(usdt.transfer(victim, amount), "InsuranceFund: transfer failed");
        emit ClaimPaid(victim, amount, noteSerial);
    }

    // ------------------------------------------------------- seizure (act-2)

    /// @notice Called by the NoteVault after transferring seizure-excess IOU
    /// here; bookkeeping only (standard 50/50 split, IOU-denominated).
    function recordSeizedIou(uint256 amount) external {
        require(msg.sender == noteVault, "InsuranceFund: only vault");
        uint256 half = amount / 2;
        seizedIouMaintenanceShare += half;
        seizedIouOverseeingShare += amount - half;
        emit SeizureExcessReceived(amount);
    }

    // ------------------------------------------------------ ERC-1155 receiver

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }
}
