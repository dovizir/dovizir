// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Stub} from "../StubDeployer.sol";
import {IAcceptanceDeployer, DovizirSystem} from "../interfaces/IAcceptanceDeployer.sol";
import {IInsuranceFund, INoteVault} from "../interfaces/IDovizir.sol";
import {MockUsdt, MemberRegistry, ReservePool, IouToken, SarrafRegistry} from "arm-b/ArmB.sol";

/// Arm B deployer — wires the arm-b IouToken subsystem; InsuranceFund and
/// NoteVault remain Stub until later iterations implement them.
contract ArmBDeployer is IAcceptanceDeployer {
    function deploy() external override returns (DovizirSystem memory system) {
        address vaultStub = address(new Stub());
        address fundStub = address(new Stub());

        MockUsdt usdt_ = new MockUsdt();
        MemberRegistry registry_ = new MemberRegistry();
        ReservePool pool_ = new ReservePool(usdt_, registry_);
        IouToken iou_ = new IouToken(address(pool_), vaultStub);
        SarrafRegistry sarrafRegistry_ = new SarrafRegistry(pool_);
        pool_.wire(iou_, sarrafRegistry_);

        system = DovizirSystem({
            usdt: usdt_,
            iouToken: iou_,
            memberRegistry: registry_,
            reservePool: pool_,
            insuranceFund: IInsuranceFund(fundStub),
            sarrafRegistry: sarrafRegistry_,
            noteVault: INoteVault(vaultStub)
        });
    }
}
