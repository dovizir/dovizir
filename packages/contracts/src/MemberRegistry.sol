// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IMemberRegistry, ISarrafRegistry} from "dovizir-acceptance/interfaces/IDovizir.sol";

/// @title MemberRegistry — single-sponsor membership records
/// @notice Implements the frozen IMemberRegistry:
///  - onboarding is Sarraf-initiated and requires the caller to be CERTIFIED;
///  - a member belongs to exactly one sponsoring Sarraf at a time;
///  - removal only by the current sponsor;
///  - rehoming only through the ReservePool's migrate flow (pool-only caller).
contract MemberRegistry is IMemberRegistry {
    ISarrafRegistry public immutable sarrafRegistry;
    address public immutable deployer;
    address public reservePool; // set once via init

    mapping(address => address) internal _sarrafOf;

    /// @notice Emitted on sponsor-initiated removal (extension event; not part
    /// of the frozen interface, which only defines Added/Rehomed).
    event MemberRemoved(address indexed member, address indexed sarraf);

    constructor(ISarrafRegistry sarrafRegistry_) {
        require(address(sarrafRegistry_) != address(0), "MemberRegistry: zero registry");
        sarrafRegistry = sarrafRegistry_;
        deployer = msg.sender;
    }

    function init(address reservePool_) external {
        require(msg.sender == deployer, "MemberRegistry: only deployer");
        require(reservePool == address(0), "MemberRegistry: already initialized");
        require(reservePool_ != address(0), "MemberRegistry: zero address");
        reservePool = reservePool_;
    }

    /// @inheritdoc IMemberRegistry
    function addMember(address member) external {
        require(sarrafRegistry.isCertified(msg.sender), "MemberRegistry: caller not certified");
        require(member != address(0), "MemberRegistry: zero member");
        require(_sarrafOf[member] == address(0), "MemberRegistry: already sponsored");
        _sarrafOf[member] = msg.sender;
        emit MemberAdded(member, msg.sender);
    }

    /// @inheritdoc IMemberRegistry
    function removeMember(address member) external {
        require(_sarrafOf[member] == msg.sender, "MemberRegistry: caller not sponsor");
        delete _sarrafOf[member];
        emit MemberRemoved(member, msg.sender);
    }

    /// @inheritdoc IMemberRegistry
    function rehome(address member, address newSarraf) external {
        require(msg.sender == reservePool, "MemberRegistry: only pool");
        address fromSarraf = _sarrafOf[member];
        require(fromSarraf != address(0), "MemberRegistry: not a member");
        require(newSarraf != address(0), "MemberRegistry: zero sarraf");
        _sarrafOf[member] = newSarraf;
        emit MemberRehomed(member, fromSarraf, newSarraf);
    }

    /// @inheritdoc IMemberRegistry
    function sarrafOf(address member) external view returns (address) {
        return _sarrafOf[member];
    }

    /// @inheritdoc IMemberRegistry
    function isMember(address member) external view returns (bool) {
        return _sarrafOf[member] != address(0);
    }
}
