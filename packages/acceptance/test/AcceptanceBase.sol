// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {
    IIouToken,
    IMemberRegistry,
    IReservePool,
    IInsuranceFund,
    ISarrafRegistry,
    INoteVault
} from "../src/interfaces/IDovizir.sol";
import {
    IAcceptanceDeployer,
    IMockUsdt,
    IErc1155Core,
    DovizirSystem
} from "../src/interfaces/IAcceptanceDeployer.sol";
import {TranscriptLib} from "../src/TranscriptLib.sol";
import {AuthLib} from "../src/AuthLib.sol";

/// @title AcceptanceBase — shared fixture for the referee suite
/// @notice Every acceptance test contract extends this. The system under test
/// is produced by an IAcceptanceDeployer resolved from the DOVIZIR_DEPLOYER
/// env var (Foundry artifact path, e.g. "src/arm/Deployer.sol:ArmDeployer").
/// Default is the compile-check StubDeployer, against which every test FAILS
/// by design. See README.md for how arms plug in.
abstract contract AcceptanceBase is Test {
    using TranscriptLib for TranscriptLib.Invoice;

    // ----------------------------------------------------------- constants
    /// Fixed genesis timestamp so TWAB windows / expiries are deterministic.
    uint256 internal constant GENESIS_TS = 1_800_000_000;
    /// PROTOCOL.md §1: certification floor cap = $1M mock USDT (6 decimals).
    uint256 internal constant FLOOR_CAP = 1_000_000e6;
    /// PROTOCOL.md §1 / IInsuranceFund: redemption fee = 90 bps.
    uint256 internal constant FEE_BPS = 90;
    /// Deposit used by the _certify helper. With <=5 equally-sized certified
    /// sarrafs, floor = n*CERT_DEPOSIT/5 <= CERT_DEPOSIT, so TWAB >= floor.
    uint256 internal constant CERT_DEPOSIT = 100_000e6;

    // -------------------------------------------------------------- system
    IMockUsdt internal usdt;
    IIouToken internal iou;
    IMemberRegistry internal registry;
    IReservePool internal pool;
    IInsuranceFund internal fund;
    ISarrafRegistry internal sarrafRegistry;
    INoteVault internal vault;

    // -------------------------------------------------------------- actors
    address internal sarrafA;
    uint256 internal sarrafAPk;
    address internal sarrafB;
    uint256 internal sarrafBPk;
    address internal memberA1;
    uint256 internal memberA1Pk;
    address internal memberA2;
    uint256 internal memberA2Pk;
    address internal memberB1;
    uint256 internal memberB1Pk;
    address internal recipient1;
    address internal recipient2;
    address internal relayer;
    address internal attacker;
    uint256 internal attackerPk;
    address internal outsider;
    address internal whale;

    function setUp() public virtual {
        vm.warp(GENESIS_TS);

        address deployer =
            deployCode(vm.envOr("DOVIZIR_DEPLOYER", string("src/StubDeployer.sol:StubDeployer")));
        DovizirSystem memory sys = IAcceptanceDeployer(deployer).deploy();
        usdt = sys.usdt;
        iou = sys.iouToken;
        registry = sys.memberRegistry;
        pool = sys.reservePool;
        fund = sys.insuranceFund;
        sarrafRegistry = sys.sarrafRegistry;
        vault = sys.noteVault;

        (sarrafA, sarrafAPk) = makeAddrAndKey("sarrafA");
        (sarrafB, sarrafBPk) = makeAddrAndKey("sarrafB");
        (memberA1, memberA1Pk) = makeAddrAndKey("memberA1");
        (memberA2, memberA2Pk) = makeAddrAndKey("memberA2");
        (memberB1, memberB1Pk) = makeAddrAndKey("memberB1");
        recipient1 = makeAddr("recipient1");
        recipient2 = makeAddr("recipient2");
        relayer = makeAddr("relayer");
        (attacker, attackerPk) = makeAddrAndKey("attacker");
        outsider = makeAddr("outsider");
        whale = makeAddr("whale");
    }

    // ------------------------------------------------------------- helpers

    function iou1155() internal view returns (IErc1155Core) {
        return IErc1155Core(address(iou));
    }

    /// IDovizir.sol: trancheId = uint256(uint160(sarraf)).
    function _id(address sarraf) internal pure returns (uint256) {
        return uint256(uint160(sarraf));
    }

    /// 90 bps redemption fee, integer division => rounds DOWN (frozen spec,
    /// see README.md).
    function _fee(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / 10_000;
    }

    function _fund(address to, uint256 amount) internal {
        usdt.mint(to, amount);
    }

    /// Deposit USDT into the sarraf's backing. NOTE (spec resolution recorded
    /// in README.md): deposit() must be callable by NOT-yet-certified sarrafs,
    /// otherwise certification (7-day TWAB of deposit >= floor) is unreachable
    /// once floor > 0. Only issue() is certification-gated.
    function _deposit(address sarraf, uint256 amount) internal {
        _fund(sarraf, amount);
        vm.startPrank(sarraf);
        usdt.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
    }

    /// Certify via the spec path: deposit, hold for the full 7-day TWAB
    /// window, self-evaluate (interpretation recorded in README.md:
    /// evaluate() evaluates msg.sender; the 24h rate limit is per sarraf).
    function _certify(address sarraf) internal {
        _deposit(sarraf, CERT_DEPOSIT);
        vm.warp(block.timestamp + 7 days);
        vm.prank(sarraf);
        sarrafRegistry.evaluate();
        assertTrue(sarrafRegistry.isCertified(sarraf), "AcceptanceBase: _certify failed");
    }

    /// Decertify via the spec's hysteresis path: a whale deposit pushes the
    /// floor to FLOOR_CAP ($1M), the sarraf's TWAB (a few 100k at most in our
    /// fixtures) is < 90% of floor, and three consecutive low evaluations
    /// (spaced > 24h) drop certification.
    function _decertify(address sarraf) internal {
        _deposit(whale, 10_000_000e6); // totalDeposits/5 > $1M => floor = FLOOR_CAP
        assertLt(
            sarrafRegistry.twabOf(sarraf),
            (FLOOR_CAP * 90) / 100,
            "AcceptanceBase: _decertify precondition (TWAB must be < 90% of floor)"
        );
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days + 1);
            vm.prank(sarraf);
            sarrafRegistry.evaluate();
        }
        assertFalse(sarrafRegistry.isCertified(sarraf), "AcceptanceBase: _decertify failed");
    }

    /// Register `member` under `sarraf` and grant the permissive operator
    /// approvals (pool + vault) so custody-transfer-style implementations
    /// work; burn/mint-style implementations simply never use them.
    function _addMember(address sarraf, address member) internal {
        vm.prank(sarraf);
        registry.addMember(member);
        _approveOperators(member);
    }

    function _approveOperators(address holder) internal {
        vm.startPrank(holder);
        iou1155().setApprovalForAll(address(pool), true);
        iou1155().setApprovalForAll(address(vault), true);
        vm.stopPrank();
    }

    /// Deposit `amount` fresh backing and issue `amount` of the sarraf's
    /// tranche to `to` (funded-only issuance keeps outstanding <= backing).
    function _issueBacked(address sarraf, address to, uint256 amount) internal {
        _deposit(sarraf, amount);
        vm.prank(sarraf);
        pool.issue(to, amount);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------- note helpers

    function _serials(uint256 n, bytes32 salt) internal pure returns (bytes32[] memory s) {
        s = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            s[i] = keccak256(abi.encode("dovizir.serial", salt, i));
        }
    }

    /// Build the canonical transcript + carver signature for spending `serial`
    /// to `recipient` (TranscriptLib is the frozen encoding).
    function _spend(bytes32 serial, address recipient, uint256 amount, bytes32 invNonce, uint256 carverPk)
        internal
        pure
        returns (bytes memory transcript, bytes memory carverSig)
    {
        TranscriptLib.Invoice memory inv =
            TranscriptLib.Invoice({recipient: recipient, amount: amount, nonce: invNonce});
        transcript = TranscriptLib.encodeTranscript(inv);
        carverSig = _sign(carverPk, TranscriptLib.spendDigest(serial, inv.invoiceHash()));
    }
}
