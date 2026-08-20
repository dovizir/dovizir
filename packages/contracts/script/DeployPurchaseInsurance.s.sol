// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {PurchaseInsurance, IIou1155} from "../src/PurchaseInsurance.sol";
import {SarrafRegistry} from "../src/SarrafRegistry.sol";

/// Deploys ONLY PurchaseInsurance against the already-live system, reading
/// the existing addresses from deployments/<chainid>.json. The rest of the
/// system keeps its state; nothing is redeployed.
///
/// Maintainer and adjudicator both default to the deployer: at PoC scale the
/// adjudicator IS the maintainer by necessity (mvp.md, "One maintainer") —
/// they are constructor addresses, so moving them later is a redeploy of this
/// one contract, not the system.
contract DeployPurchaseInsurance is Script {
    using stdJson for string;

    function run() external {
        string memory path =
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        address iou = json.readAddress(".iouToken");
        address registry = json.readAddress(".sarrafRegistry");
        require(iou != address(0) && registry != address(0), "missing base deployment");

        uint256 pk = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(pk);
        console2.log("deployer", deployer);
        console2.log("iouToken", iou);
        console2.log("sarrafRegistry", registry);

        vm.startBroadcast(pk);
        PurchaseInsurance pi = new PurchaseInsurance(
            IIou1155(iou), SarrafRegistry(registry), deployer, deployer
        );
        vm.stopBroadcast();

        console2.log("purchaseInsurance", address(pi));
    }
}
