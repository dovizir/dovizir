// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {KycRegistry} from "../src/KycRegistry.sol";
import {MemberRegistry} from "../src/MemberRegistry.sol";
import {SarrafRegistry} from "../src/SarrafRegistry.sol";

/// Deploys ONLY KycRegistry against the live system (same pattern as
/// DeployPurchaseInsurance): existing addresses from deployments/<chainid>.json,
/// nothing redeployed.
contract DeployKycRegistry is Script {
    using stdJson for string;

    function run() external {
        string memory path =
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        address members = json.readAddress(".memberRegistry");
        address sarrafs = json.readAddress(".sarrafRegistry");
        require(members != address(0) && sarrafs != address(0), "missing base deployment");

        uint256 pk = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(pk);
        KycRegistry kyc = new KycRegistry(MemberRegistry(members), SarrafRegistry(sarrafs));
        vm.stopBroadcast();
        console2.log("kycRegistry", address(kyc));
    }
}
