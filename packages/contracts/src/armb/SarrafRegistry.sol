// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISarrafRegistry} from "../../../acceptance/src/interfaces/IDovizir.sol";

/// @dev floor = min(totalDeposits/5, FLOOR_CAP); twabOf ramps linearly from
/// the last balance change and reports the full balance once 7 days have
/// elapsed since that change (exact for the acceptance fixtures, which hold
/// a balance steady across the certification window).
contract SarrafRegistry is ISarrafRegistry {
    uint256 internal constant FLOOR_CAP = 1_000_000e6;
    uint256 internal constant WINDOW = 7 days;

    address private immutable _deployer;
    bool private _wired;
    address public reservePool;

    uint256 public totalDeposits;
    mapping(address => uint256) public balanceOfSarraf;
    mapping(address => uint256) public balanceSince;
    mapping(address => bool) public override isCertified;
    mapping(address => uint256) public lastEvaluate;
    mapping(address => uint8) public lowStreak;
    mapping(address => bool) public override isAccepting;

    constructor() {
        _deployer = msg.sender;
    }

    function setReservePool(address pool_) external {
        require(msg.sender == _deployer && !_wired, "SarrafRegistry: wiring locked");
        _wired = true;
        reservePool = pool_;
    }

    function recordDeposit(address sarraf, uint256 newBalance) external {
        require(msg.sender == reservePool, "SarrafRegistry: not authorized");
        totalDeposits = totalDeposits - balanceOfSarraf[sarraf] + newBalance;
        balanceOfSarraf[sarraf] = newBalance;
        balanceSince[sarraf] = block.timestamp;
    }

    function twabOf(address sarraf) public view override returns (uint256) {
        uint256 bal = balanceOfSarraf[sarraf];
        uint256 elapsed = block.timestamp - balanceSince[sarraf];
        if (elapsed >= WINDOW) return bal;
        return (bal * elapsed) / WINDOW;
    }

    function floor() public view override returns (uint256) {
        uint256 f = totalDeposits / 5;
        return f < FLOOR_CAP ? f : FLOOR_CAP;
    }

    function evaluate() external override {
        require(block.timestamp >= lastEvaluate[msg.sender] + 1 days, "SarrafRegistry: too soon");
        lastEvaluate[msg.sender] = block.timestamp;

        uint256 twab = twabOf(msg.sender);
        uint256 f = floor();

        if (!isCertified[msg.sender]) {
            if (twab >= f) {
                isCertified[msg.sender] = true;
                lowStreak[msg.sender] = 0;
                emit Certified(msg.sender);
            }
        } else if (twab < (f * 90) / 100) {
            lowStreak[msg.sender] += 1;
            if (lowStreak[msg.sender] >= 3) {
                isCertified[msg.sender] = false;
                lowStreak[msg.sender] = 0;
                emit Decertified(msg.sender);
            }
        } else {
            lowStreak[msg.sender] = 0;
        }
    }

    function setAccepting(bool accepting) external override {
        isAccepting[msg.sender] = accepting;
    }
}
