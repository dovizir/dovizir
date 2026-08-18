// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMemberRegistry, ISarrafRegistry} from "../../../acceptance/src/interfaces/IDovizir.sol";

contract MemberRegistry is IMemberRegistry {
    ISarrafRegistry public immutable sarrafRegistry;
    address private immutable _deployer;
    bool private _wired;
    address public reservePool;

    mapping(address => address) public override sarrafOf;

    constructor(address sarrafRegistry_) {
        sarrafRegistry = ISarrafRegistry(sarrafRegistry_);
        _deployer = msg.sender;
    }

    function setReservePool(address pool_) external {
        require(msg.sender == _deployer && !_wired, "MemberRegistry: wiring locked");
        _wired = true;
        reservePool = pool_;
    }

    function addMember(address member) external override {
        require(sarrafRegistry.isCertified(msg.sender), "MemberRegistry: not certified");
        require(sarrafOf[member] == address(0), "MemberRegistry: already member");
        sarrafOf[member] = msg.sender;
        emit MemberAdded(member, msg.sender);
    }

    function removeMember(address member) external override {
        require(sarrafOf[member] == msg.sender, "MemberRegistry: not sponsor");
        sarrafOf[member] = address(0);
    }

    function isMember(address member) external view override returns (bool) {
        return sarrafOf[member] != address(0);
    }

    function rehome(address member, address newSarraf) external override {
        require(msg.sender == reservePool, "MemberRegistry: not authorized");
        address oldSarraf = sarrafOf[member];
        sarrafOf[member] = newSarraf;
        emit MemberRehomed(member, oldSarraf, newSarraf);
    }
}
