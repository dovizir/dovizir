// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAcceptanceDeployer, IMockUsdt, DovizirSystem} from "../interfaces/IAcceptanceDeployer.sol";
import {
    IIouToken,
    IMemberRegistry,
    IReservePool,
    IInsuranceFund,
    ISarrafRegistry,
    INoteVault
} from "../interfaces/IDovizir.sol";

import {MockUsdt} from "arm-a/MockUsdt.sol";
import {IouToken} from "arm-a/IouToken.sol";
import {MemberRegistry} from "arm-a/MemberRegistry.sol";
import {ReservePool, IUsdt} from "arm-a/ReservePool.sol";
import {InsuranceFund, IUsdtLike} from "arm-a/InsuranceFund.sol";
import {SarrafRegistry} from "arm-a/SarrafRegistry.sol";
import {NoteVault} from "arm-a/NoteVault.sol";

/// @title ArmADeployer — Arm A's IAcceptanceDeployer (dual-build experiment)
/// @notice Deploys and fully wires a fresh Arm A system on every call:
///  1. MockUsdt, IouToken, SarrafRegistry, MemberRegistry, InsuranceFund are
///     deployed with this contract as their one-time initializer;
///  2. ReservePool and NoteVault take their immutable dependencies;
///  3. the one-time init() calls close the circular references (IouToken's
///     authorized minters = pool + vault; SarrafRegistry/MemberRegistry's
///     pool-only hooks; InsuranceFund's pool fee source + vault claim payer).
/// After init, no privileged role remains anywhere in the system.
contract ArmADeployer is IAcceptanceDeployer {
    function deploy() external override returns (DovizirSystem memory system) {
        MockUsdt usdt = new MockUsdt();
        IouToken iou = new IouToken();
        SarrafRegistry sarrafRegistry = new SarrafRegistry(0); // 0 => production 7-day window
        MemberRegistry memberRegistry = new MemberRegistry(sarrafRegistry);
        InsuranceFund fund = new InsuranceFund(IUsdtLike(address(usdt)));
        ReservePool pool = new ReservePool(
            IUsdt(address(usdt)),
            IIouToken(address(iou)),
            memberRegistry,
            sarrafRegistry,
            fund
        );
        NoteVault vault = new NoteVault(iou, memberRegistry, fund);

        iou.init(address(pool), address(vault));
        sarrafRegistry.init(address(pool));
        memberRegistry.init(address(pool));
        fund.init(address(pool), address(vault));

        system = DovizirSystem({
            usdt: IMockUsdt(address(usdt)),
            iouToken: IIouToken(address(iou)),
            memberRegistry: IMemberRegistry(address(memberRegistry)),
            reservePool: IReservePool(address(pool)),
            insuranceFund: IInsuranceFund(address(fund)),
            sarrafRegistry: ISarrafRegistry(address(sarrafRegistry)),
            noteVault: INoteVault(address(vault))
        });
    }
}
