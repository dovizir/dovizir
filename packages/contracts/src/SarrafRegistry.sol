// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ISarrafRegistry} from "dovizir-acceptance/interfaces/IDovizir.sol";

interface IPoolTotals {
    function totalDeposits() external view returns (uint256);
}

/// @title SarrafRegistry — TWAB-based Sarraf certification with hysteresis
/// @notice Implements the frozen ISarrafRegistry:
///  - certification floor = min(totalDeposits / 5, 1_000_000e6) using SPOT
///    total deposits (referee interpretation);
///  - a sarraf's 7-day TWAB of pool backing is computed from cumulative
///    balance checkpoints pushed by the ReservePool on every backing change;
///  - hysteresis: enter at TWAB >= floor; once certified, drop only after TWAB
///    < 90% of floor on 3 CONSECUTIVE evaluations (a recovered evaluation
///    resets the streak);
///  - evaluate() evaluates msg.sender and is rate-limited to once per 24h per
///    sarraf (referee interpretation).
///
/// TWAB design: per-sarraf checkpoint array of
/// (timestamp, balance, cumulative ∫balance·dt). The average over the trailing
/// window is (cumAt(now) − cumAt(now − 7d)) / 7d, with a single integer
/// division at the end so a constant balance held over the whole window yields
/// the exact balance (the referee asserts exact TWAB values).
contract SarrafRegistry is ISarrafRegistry {
    // ------------------------------------------------------------- constants
    uint256 public constant FLOOR_CAP = 1_000_000e6; // $1M in 6-decimal mock USDT
    /// @dev 7 days on mainnet/tests. Made immutable (default-preserving: a 0
    /// constructor arg keeps 7 days) so a TESTNET deploy can pass a short window
    /// and let a Sarraf certify in minutes instead of waiting 7 real days. Never
    /// pass a non-zero value on a production deploy.
    uint256 public immutable TWAB_WINDOW;
    uint256 public constant EVALUATE_COOLDOWN = 24 hours;
    uint256 public constant EXIT_BPS = 90_00; // exit threshold: 90% of floor
    uint8 public constant LOW_STREAK_TO_DROP = 3;

    // --------------------------------------------------------------- storage
    struct Checkpoint {
        uint64 timestamp;
        uint192 balance; // pool backing after the change (fits any 6-dec amount)
        uint256 cumulative; // ∫ balance dt from first checkpoint to `timestamp`
    }

    address public immutable deployer;
    address public reservePool; // set once via init

    mapping(address => Checkpoint[]) internal _checkpoints;
    mapping(address => bool) internal _certified;
    mapping(address => bool) internal _accepting;
    mapping(address => uint64) public lastEvaluatedAt;
    mapping(address => uint8) public lowStreak;

    /// @param twabWindow_ TWAB averaging window in seconds; pass 0 for the
    /// production default of 7 days. A short value is TESTNET-ONLY.
    constructor(uint256 twabWindow_) {
        deployer = msg.sender;
        TWAB_WINDOW = twabWindow_ == 0 ? 7 days : twabWindow_;
    }

    function init(address reservePool_) external {
        require(msg.sender == deployer, "SarrafRegistry: only deployer");
        require(reservePool == address(0), "SarrafRegistry: already initialized");
        require(reservePool_ != address(0), "SarrafRegistry: zero address");
        reservePool = reservePool_;
    }

    // -------------------------------------------------------- pool checkpoint

    /// @notice Pushed by the ReservePool on every backing change for `sarraf`.
    function checkpoint(address sarraf, uint256 newBalance) external {
        require(msg.sender == reservePool, "SarrafRegistry: only pool");
        require(newBalance <= type(uint192).max, "SarrafRegistry: balance overflow");
        Checkpoint[] storage cps = _checkpoints[sarraf];
        uint256 n = cps.length;
        if (n > 0 && cps[n - 1].timestamp == uint64(block.timestamp)) {
            // Same-second update: cumulative unchanged (dt = 0), balance replaced.
            cps[n - 1].balance = uint192(newBalance);
            return;
        }
        uint256 cum;
        if (n > 0) {
            Checkpoint storage last = cps[n - 1];
            cum = last.cumulative + uint256(last.balance) * (block.timestamp - last.timestamp);
        }
        cps.push(
            Checkpoint({timestamp: uint64(block.timestamp), balance: uint192(newBalance), cumulative: cum})
        );
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ISarrafRegistry
    function floor() public view returns (uint256) {
        uint256 fifth = IPoolTotals(reservePool).totalDeposits() / 5;
        return fifth < FLOOR_CAP ? fifth : FLOOR_CAP;
    }

    /// @inheritdoc ISarrafRegistry
    function twabOf(address sarraf) public view returns (uint256) {
        Checkpoint[] storage cps = _checkpoints[sarraf];
        if (cps.length == 0) return 0;
        uint256 nowTs = block.timestamp;
        uint256 windowStart = nowTs > TWAB_WINDOW ? nowTs - TWAB_WINDOW : 0;
        uint256 cumEnd = _cumulativeAt(cps, nowTs);
        uint256 cumStart = _cumulativeAt(cps, windowStart);
        return (cumEnd - cumStart) / TWAB_WINDOW;
    }

    /// @inheritdoc ISarrafRegistry
    function isCertified(address sarraf) external view returns (bool) {
        return _certified[sarraf];
    }

    /// @inheritdoc ISarrafRegistry
    function isAccepting(address sarraf) external view returns (bool) {
        return _accepting[sarraf];
    }

    // -------------------------------------------------------------- mutations

    /// @inheritdoc ISarrafRegistry
    function evaluate() external {
        uint64 last = lastEvaluatedAt[msg.sender];
        require(last == 0 || block.timestamp >= uint256(last) + EVALUATE_COOLDOWN, "SarrafRegistry: cooldown");
        lastEvaluatedAt[msg.sender] = uint64(block.timestamp);

        uint256 twab = twabOf(msg.sender);
        uint256 floorNow = floor();

        if (!_certified[msg.sender]) {
            if (twab >= floorNow) {
                _certified[msg.sender] = true;
                lowStreak[msg.sender] = 0;
                emit Certified(msg.sender);
            }
            return;
        }

        // Hysteresis exit: STRICTLY below 90% of floor counts as low.
        if (twab < (floorNow * EXIT_BPS) / 100_00) {
            uint8 streak = lowStreak[msg.sender] + 1;
            if (streak >= LOW_STREAK_TO_DROP) {
                _certified[msg.sender] = false;
                lowStreak[msg.sender] = 0;
                emit Decertified(msg.sender);
            } else {
                lowStreak[msg.sender] = streak;
            }
        } else {
            lowStreak[msg.sender] = 0; // recovered evaluation resets the streak
        }
    }

    /// @inheritdoc ISarrafRegistry
    function setAccepting(bool accepting) external {
        _accepting[msg.sender] = accepting;
    }

    // ------------------------------------------------------------- internals

    /// @dev Cumulative ∫balance·dt at time `t`: binary-search the rightmost
    /// checkpoint with timestamp <= t, then extend linearly.
    function _cumulativeAt(Checkpoint[] storage cps, uint256 t) internal view returns (uint256) {
        uint256 n = cps.length;
        if (n == 0 || t < cps[0].timestamp) return 0;
        uint256 lo = 0;
        uint256 hi = n - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (cps[mid].timestamp <= t) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        Checkpoint storage cp = cps[lo];
        return cp.cumulative + uint256(cp.balance) * (t - cp.timestamp);
    }
}
