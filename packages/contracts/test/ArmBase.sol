// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUsdt} from "../src/MockUsdt.sol";
import {IouToken} from "../src/IouToken.sol";
import {MemberRegistry} from "../src/MemberRegistry.sol";
import {ReservePool, IUsdt} from "../src/ReservePool.sol";
import {InsuranceFund, IUsdtLike} from "../src/InsuranceFund.sol";
import {SarrafRegistry} from "../src/SarrafRegistry.sol";
import {NoteVault} from "../src/NoteVault.sol";
import {IIouToken} from "dovizir-acceptance/interfaces/IDovizir.sol";
import {TranscriptLib} from "dovizir-acceptance/TranscriptLib.sol";

/// @title ArmBase — Arm A's own test fixture over the CONCRETE contracts
/// @notice Unlike the referee's AcceptanceBase (interface-typed), this fixture
/// exposes the concrete types so arm-internal surfaces (seizure epochs,
/// seized-IOU bookkeeping, remainingOf, init guards) are testable.
abstract contract ArmBase is Test {
    uint256 internal constant GENESIS_TS = 1_800_000_000;

    MockUsdt internal usdt;
    IouToken internal iou;
    MemberRegistry internal registry;
    ReservePool internal pool;
    InsuranceFund internal fund;
    SarrafRegistry internal sarrafRegistry;
    NoteVault internal vault;

    address internal sarrafA;
    uint256 internal sarrafAPk;
    address internal sarrafB;
    uint256 internal sarrafBPk;
    address internal memberA1;
    uint256 internal memberA1Pk;
    address internal memberA2;
    uint256 internal memberA2Pk;
    address internal recipient1;
    address internal recipient2;
    address internal attacker;
    uint256 internal attackerPk;
    address internal outsider;

    function setUp() public virtual {
        vm.warp(GENESIS_TS);

        usdt = new MockUsdt();
        iou = new IouToken();
        sarrafRegistry = new SarrafRegistry();
        registry = new MemberRegistry(sarrafRegistry);
        fund = new InsuranceFund(IUsdtLike(address(usdt)));
        pool = new ReservePool(
            IUsdt(address(usdt)), IIouToken(address(iou)), registry, sarrafRegistry, fund
        );
        vault = new NoteVault(iou, registry, fund);
        iou.init(address(pool), address(vault));
        sarrafRegistry.init(address(pool));
        registry.init(address(pool));
        fund.init(address(pool), address(vault));

        (sarrafA, sarrafAPk) = makeAddrAndKey("sarrafA");
        (sarrafB, sarrafBPk) = makeAddrAndKey("sarrafB");
        (memberA1, memberA1Pk) = makeAddrAndKey("memberA1");
        (memberA2, memberA2Pk) = makeAddrAndKey("memberA2");
        recipient1 = makeAddr("recipient1");
        recipient2 = makeAddr("recipient2");
        (attacker, attackerPk) = makeAddrAndKey("attacker");
        outsider = makeAddr("outsider");
    }

    // ------------------------------------------------------------- helpers

    function _id(address sarraf) internal pure returns (uint256) {
        return uint256(uint160(sarraf));
    }

    function _deposit(address sarraf, uint256 amount) internal {
        usdt.mint(sarraf, amount);
        vm.startPrank(sarraf);
        usdt.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
    }

    function _certify(address sarraf) internal {
        _deposit(sarraf, 100_000e6);
        vm.warp(block.timestamp + 7 days);
        vm.prank(sarraf);
        sarrafRegistry.evaluate();
        assertTrue(sarrafRegistry.isCertified(sarraf), "ArmBase: certify failed");
    }

    function _addMember(address sarraf, address member) internal {
        vm.prank(sarraf);
        registry.addMember(member);
        vm.startPrank(member);
        iou.setApprovalForAll(address(pool), true);
        iou.setApprovalForAll(address(vault), true);
        vm.stopPrank();
    }

    function _issueBacked(address sarraf, address to, uint256 amount) internal {
        _deposit(sarraf, amount);
        vm.prank(sarraf);
        pool.issue(to, amount);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _serials(uint256 n, bytes32 salt) internal pure returns (bytes32[] memory s) {
        s = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            s[i] = keccak256(abi.encode("arm-a.serial", salt, i));
        }
    }

    /// §5 amendment: the spend digest now signs expiry + batchRoot, so the
    /// helper threads the batch's root and expiry.
    function _spend(
        bytes32 serial,
        address recipient,
        uint256 amount,
        bytes32 invNonce,
        uint256 carverPk,
        bytes32 batchRoot,
        uint64 noteExpiry
    ) internal pure returns (bytes memory transcript, bytes memory carverSig) {
        TranscriptLib.Invoice memory inv =
            TranscriptLib.Invoice({recipient: recipient, amount: amount, nonce: invNonce});
        transcript = TranscriptLib.encodeTranscript(inv);
        carverSig =
            _sign(carverPk, TranscriptLib.spendDigest(serial, TranscriptLib.invoiceHash(inv), noteExpiry, batchRoot));
    }
}
