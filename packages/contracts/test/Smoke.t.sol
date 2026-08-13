// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Fees} from "../src/Fees.sol";
import {ReservePool} from "../src/ReservePool.sol";

// M0 smoke tests for the legacy MVP contracts. These pin current behavior so CI
// is meaningful before the M1 rewrite (issuer-tranched IOU, member registry,
// insurance fund) replaces both contracts.
contract SmokeTest is Test {
    Fees fees;
    ReservePool pool;
    address treasury = makeAddr("treasury");
    address member = makeAddr("member");

    function setUp() public {
        fees = new Fees(treasury, 0.001 ether, 0.002 ether);
        pool = new ReservePool(address(fees));
    }

    function test_feeParamsSetByOwner() public {
        fees.setParams(treasury, 1, 2);
        assertEq(fees.issuanceFee(), 1);
        assertEq(fees.redemptionFee(), 2);
    }

    function test_setParamsRevertsForNonOwner() public {
        vm.prank(member);
        vm.expectRevert(bytes("OWNER"));
        fees.setParams(member, 0, 0);
    }

    function test_depositCreditsMember() public {
        pool.deposit(member, 100);
        assertEq(pool.reserveBalance(member), 100);
    }

    function test_issueRequiresExactFeeAndForwardsToTreasury() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(bytes("FEE"));
        pool.issueIOU{value: 0}(member, member, 50);

        uint256 before = treasury.balance;
        pool.issueIOU{value: 0.001 ether}(member, member, 50);
        assertEq(treasury.balance - before, 0.001 ether);
        assertEq(pool.reserveBalance(member), 50);
    }

    function test_redeemDebitsAndCanGoNegative() public {
        vm.deal(address(this), 1 ether);
        pool.redeem{value: 0.002 ether}(member, 10);
        // Documents the known negative-balance foot-gun; M1 removes signed balances.
        assertEq(pool.reserveBalance(member), -10);
    }
}
