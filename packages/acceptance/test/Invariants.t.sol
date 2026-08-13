// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AcceptanceBase} from "./AcceptanceBase.sol";
import {DovizirHandler} from "./handlers/DovizirHandler.sol";
import {DovizirSystem, IMockUsdt} from "../src/interfaces/IAcceptanceDeployer.sol";
import {
    IIouToken,
    IMemberRegistry,
    IReservePool,
    IInsuranceFund,
    ISarrafRegistry,
    INoteVault
} from "../src/interfaces/IDovizir.sol";

/// Protocol invariants (PROTOCOL.md §3: "invariant violations (0 required)").
/// Random bounded ops are driven through DovizirHandler over a closed set of
/// holders; the properties below must hold after every call sequence.
contract InvariantsTest is AcceptanceBase {
    DovizirHandler internal handler;

    address[] internal sarrafList;
    address[] internal memberList;
    uint256[] internal memberPkList;
    address[] internal memberSarrafList;
    address[] internal recipientList;
    address[] internal holderList; // members + recipients (closed under handler ops)

    function setUp() public override {
        super.setUp();

        _certify(sarrafA);
        _certify(sarrafB);
        _addMember(sarrafA, memberA1);
        _addMember(sarrafA, memberA2);
        _addMember(sarrafB, memberB1);
        _approveOperators(recipient1);
        _approveOperators(recipient2);
        // Extra initial backing so opIssue has headroom from call one.
        _deposit(sarrafA, 400_000e6);
        _deposit(sarrafB, 200_000e6);

        sarrafList = [sarrafA, sarrafB];
        memberList = [memberA1, memberA2, memberB1];
        memberPkList = [memberA1Pk, memberA2Pk, memberB1Pk];
        memberSarrafList = [sarrafA, sarrafA, sarrafB];
        recipientList = [recipient1, recipient2];
        holderList = [memberA1, memberA2, memberB1, recipient1, recipient2];

        handler = new DovizirHandler(
            DovizirSystem({
                usdt: usdt,
                iouToken: iou,
                memberRegistry: registry,
                reservePool: pool,
                insuranceFund: fund,
                sarrafRegistry: sarrafRegistry,
                noteVault: vault
            }),
            sarrafList,
            memberList,
            memberPkList,
            memberSarrafList,
            recipientList
        );

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = DovizirHandler.opDeposit.selector;
        selectors[1] = DovizirHandler.opIssue.selector;
        selectors[2] = DovizirHandler.opRedeem.selector;
        selectors[3] = DovizirHandler.opTransfer.selector;
        selectors[4] = DovizirHandler.opCarve.selector;
        selectors[5] = DovizirHandler.opReconcile.selector;
        selectors[6] = DovizirHandler.opReplay.selector;
        selectors[7] = DovizirHandler.opRefundExpired.selector;
        selectors[8] = DovizirHandler.opWarp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// INVARIANT (a) — tranche supply accounting, defined precisely as:
    /// for every sarraf s,
    ///   outstandingOf(s) == Σ_{h ∈ holders} iou.balanceOf(h, id(s))
    ///                       + Σ_{m ∈ members sponsored by s} vault.lockedOf(m)
    /// where `holders` is the closed set the handler moves value between and
    /// the NoteVault itself is EXCLUDED from the sum. This holds whether the
    /// vault escrows locked IOU (its custody balance is exactly Σ lockedOf,
    /// counted once via lockedOf) or burns-on-carve / mints-on-release.
    function invariant_outstandingEqualsCirculatingPlusLocked() public view {
        for (uint256 s; s < sarrafList.length; ++s) {
            address sarraf = sarrafList[s];
            uint256 circulating;
            for (uint256 h; h < holderList.length; ++h) {
                circulating += iou1155().balanceOf(holderList[h], _id(sarraf));
            }
            uint256 locked;
            for (uint256 m; m < memberList.length; ++m) {
                if (memberSarrafList[m] == sarraf) {
                    locked += vault.lockedOf(memberList[m]);
                }
            }
            assertEq(
                pool.outstandingOf(sarraf),
                circulating + locked,
                "invariant (a): outstanding == circulating + vault-locked"
            );
        }
    }

    /// INVARIANT (b) — PROTOCOL.md §1 funded-only issuance:
    /// backingOf(s) >= outstandingOf(s) at all times, for every sarraf.
    function invariant_backingCoversOutstanding() public view {
        for (uint256 s; s < sarrafList.length; ++s) {
            assertGe(
                pool.backingOf(sarrafList[s]),
                pool.outstandingOf(sarrafList[s]),
                "invariant (b): backing must cover outstanding"
            );
        }
    }

    /// INVARIANT (c) — IInsuranceFund bookkeeping:
    /// totalReserves() == overseeingShare() + maintenanceShare() always.
    function invariant_fundSharesPartitionTotalReserves() public view {
        assertEq(
            fund.totalReserves(),
            fund.overseeingShare() + fund.maintenanceShare(),
            "invariant (c): shares must partition total reserves"
        );
    }

    /// INVARIANT (d) — no note serial ever pays twice (ghost-variable check
    /// over every payment the handler observed, including byte-identical
    /// replay attempts), and every paid serial reports isSpent.
    function invariant_noSerialPaysTwice() public view {
        uint256 n = handler.paidSerialCount();
        for (uint256 i; i < n; ++i) {
            bytes32 serial = handler.paidSerials(i);
            assertLe(handler.timesPaid(serial), 1, "invariant (d): a serial paid more than once");
            assertTrue(vault.isSpent(serial), "invariant (d): paid serial must report isSpent");
        }
    }
}
