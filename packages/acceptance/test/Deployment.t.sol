// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AcceptanceBase} from "./AcceptanceBase.sol";

/// Sanity checks on the arm's IAcceptanceDeployer output (the harness itself).
contract DeploymentTest is AcceptanceBase {
    /// IAcceptanceDeployer: deploy() returns a fully wired system — all seven
    /// components present and distinct.
    function test_deploy_returnsSevenDistinctComponents() public view {
        address[7] memory addrs = [
            address(usdt),
            address(iou),
            address(registry),
            address(pool),
            address(fund),
            address(sarrafRegistry),
            address(vault)
        ];
        for (uint256 i; i < addrs.length; ++i) {
            assertTrue(addrs[i] != address(0), "component missing");
            for (uint256 j = i + 1; j < addrs.length; ++j) {
                assertTrue(addrs[i] != addrs[j], "components must be distinct contracts");
            }
        }
    }

    /// IAcceptanceDeployer: mock USDT MUST report 6 decimals (all protocol
    /// dollar constants — FLOOR_CAP etc. — are 6-decimal denominated).
    function test_mockUsdt_hasSixDecimals() public view {
        assertEq(usdt.decimals(), 6, "mock USDT must have 6 decimals");
    }

    /// IAcceptanceDeployer: mock USDT mint is open — the suite funds arbitrary
    /// addresses with it.
    function test_mockUsdt_openMint_fundsArbitraryAddresses() public {
        vm.prank(outsider); // even an unprivileged caller can mint
        usdt.mint(recipient1, 123e6);
        assertEq(usdt.balanceOf(recipient1), 123e6, "open mint must credit recipient");

        usdt.mint(attacker, 1e6);
        assertEq(usdt.balanceOf(attacker), 1e6);
    }
}
