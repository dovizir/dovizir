// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {MockUsdt} from "../src/MockUsdt.sol";
import {IouToken} from "../src/IouToken.sol";
import {SarrafRegistry} from "../src/SarrafRegistry.sol";
import {MemberRegistry} from "../src/MemberRegistry.sol";
import {InsuranceFund, IUsdtLike} from "../src/InsuranceFund.sol";
import {ReservePool, IUsdt} from "../src/ReservePool.sol";
import {NoteVault} from "../src/NoteVault.sol";
import {Escrow, IEscrowIou} from "../src/Escrow.sol";
import {IIouToken} from "dovizir-acceptance/interfaces/IDovizir.sol";

/// @title Deploy — full Dovizir M1 system deploy + init wiring (real broadcast)
/// @notice Deploys and wires the whole M1 stack in the EXACT order/wiring that
/// packages/acceptance/src/arm/ArmADeployer.sol performs in-memory, but as a
/// real broadcast against a live RPC. The broadcasting key is the one-time
/// initializer for every contract (its address is `deployer` inside each
/// contract), so the four `init()` calls below must run from the SAME key.
///
/// Parameterization — the SAME script deploys to anvil OR Base Sepolia; only
/// the RPC url and key differ:
///
///   Local anvil (chain-id 84532 to match the app's Base Sepolia config):
///     anvil --chain-id 84532 &
///     PRIVATE_KEY=<anvil-acct-0-key> \
///       forge script script/Deploy.s.sol:Deploy \
///       --rpc-url http://127.0.0.1:8545 --broadcast
///
///   Base Sepolia (when a funded key is available):
///     PRIVATE_KEY=$PK \
///       forge script script/Deploy.s.sol:Deploy \
///       --rpc-url $BASE_SEPOLIA_RPC --broadcast --private-key $PK
///
/// Outputs (both to stdout AND disk):
///   - deployments/<chainid>.json     : machine-readable address map
///   - deployments/<chainid>.env      : NEXT_PUBLIC_* block for apps/web/.env.local
contract Deploy is Script {
    struct System {
        MockUsdt usdt;
        IouToken iou;
        SarrafRegistry sarrafRegistry;
        MemberRegistry memberRegistry;
        InsuranceFund fund;
        ReservePool pool;
        NoteVault vault;
        Escrow escrow;
    }

    function run() external returns (System memory sys) {
        // Deployer key: prefer PRIVATE_KEY env; otherwise fall back to the
        // --private-key / --sender the caller passed to `forge script`.
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        // The deployer/maintainer address doubles as the escrow's backstop
        // arbiter (fiat-ramp §4): a fallback dispute resolver that can only act
        // after DISPUTE_TIMEOUT, so no dispute is ever permanently stranded.
        address deployer;
        if (pk != 0) {
            deployer = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            deployer = msg.sender;
            vm.startBroadcast();
        }

        // 1. Leaf contracts whose one-time initializer is this deployer key.
        sys.usdt = new MockUsdt();
        sys.iou = new IouToken();
        // TWAB_WINDOW: 0 => production 7-day default. Set the TWAB_WINDOW env
        // (seconds) on a TESTNET deploy to let a Sarraf certify in minutes.
        sys.sarrafRegistry = new SarrafRegistry(vm.envOr("TWAB_WINDOW", uint256(0)));
        sys.memberRegistry = new MemberRegistry(sys.sarrafRegistry);
        sys.fund = new InsuranceFund(IUsdtLike(address(sys.usdt)));

        // 2. Contracts that take their dependencies as immutables.
        sys.pool = new ReservePool(
            IUsdt(address(sys.usdt)),
            IIouToken(address(sys.iou)),
            sys.memberRegistry,
            sys.sarrafRegistry,
            sys.fund
        );
        sys.vault = new NoteVault(sys.iou, sys.memberRegistry, sys.fund);

        // 3. Close the circular references via the one-time init() calls —
        //    IOU minters = pool + vault; pool-only hooks on the registries;
        //    fund fee-source = pool, claim-payer = vault. After this, no
        //    privileged role remains anywhere in the system.
        sys.iou.init(address(sys.pool), address(sys.vault));
        sys.sarrafRegistry.init(address(sys.pool));
        sys.memberRegistry.init(address(sys.pool));
        sys.fund.init(address(sys.pool), address(sys.vault));

        // 4. P2P escrow (fiat-ramp Part B). Permissionless: it holds no
        //    privileged role — makers `setApprovalForAll(escrow)` and lock IOU
        //    themselves; the arbiter is derived from the tranche at resolve
        //    time. It only needs the IOU address to custody + release tranches.
        sys.escrow = new Escrow(IEscrowIou(address(sys.iou)), deployer);

        vm.stopBroadcast();

        _report(sys);
        _write(sys);
    }

    function _report(System memory sys) internal view {
        console2.log("== Dovizir M1 deployed ==");
        console2.log("chainId          ", block.chainid);
        console2.log("MockUsdt         ", address(sys.usdt));
        console2.log("IouToken         ", address(sys.iou));
        console2.log("SarrafRegistry   ", address(sys.sarrafRegistry));
        console2.log("MemberRegistry   ", address(sys.memberRegistry));
        console2.log("InsuranceFund    ", address(sys.fund));
        console2.log("ReservePool      ", address(sys.pool));
        console2.log("NoteVault        ", address(sys.vault));
        console2.log("Escrow           ", address(sys.escrow));
        console2.log("Escrow.backstop  ", sys.escrow.backstopArbiter());
    }

    function _write(System memory sys) internal {
        string memory chainId = vm.toString(block.chainid);

        // ---- deployments/<chainid>.json (machine-readable) ----
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "usdt", address(sys.usdt));
        vm.serializeAddress(obj, "iouToken", address(sys.iou));
        vm.serializeAddress(obj, "sarrafRegistry", address(sys.sarrafRegistry));
        vm.serializeAddress(obj, "memberRegistry", address(sys.memberRegistry));
        vm.serializeAddress(obj, "insuranceFund", address(sys.fund));
        vm.serializeAddress(obj, "reservePool", address(sys.pool));
        vm.serializeAddress(obj, "noteVault", address(sys.vault));
        string memory json = vm.serializeAddress(obj, "escrow", address(sys.escrow));
        string memory jsonPath = string.concat("deployments/", chainId, ".json");
        vm.writeJson(json, jsonPath);
        console2.log("wrote", jsonPath);

        // ---- deployments/<chainid>.env (NEXT_PUBLIC_* block for the web app) ----
        // Names match packages/sdk/src/addresses.ts exactly.
        string memory env = string.concat(
            "# Generated by script/Deploy.s.sol for chainId ", chainId, "\n",
            "NEXT_PUBLIC_USDT_ADDRESS=", vm.toString(address(sys.usdt)), "\n",
            "NEXT_PUBLIC_IOU_TOKEN_ADDRESS=", vm.toString(address(sys.iou)), "\n",
            "NEXT_PUBLIC_SARRAF_REGISTRY_ADDRESS=", vm.toString(address(sys.sarrafRegistry)), "\n",
            "NEXT_PUBLIC_MEMBER_REGISTRY_ADDRESS=", vm.toString(address(sys.memberRegistry)), "\n",
            "NEXT_PUBLIC_INSURANCE_FUND_ADDRESS=", vm.toString(address(sys.fund)), "\n",
            "NEXT_PUBLIC_RESERVE_POOL_ADDRESS=", vm.toString(address(sys.pool)), "\n",
            "NEXT_PUBLIC_NOTE_VAULT_ADDRESS=", vm.toString(address(sys.vault)), "\n",
            "NEXT_PUBLIC_ESCROW_ADDRESS=", vm.toString(address(sys.escrow)), "\n"
        );
        string memory envPath = string.concat("deployments/", chainId, ".env");
        vm.writeFile(envPath, env);
        console2.log("wrote", envPath);
    }
}
