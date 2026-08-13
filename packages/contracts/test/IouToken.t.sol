// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArmBase} from "./ArmBase.sol";
import {IouToken} from "../src/IouToken.sol";
import {AuthLib} from "dovizir-acceptance/AuthLib.sol";

contract Erc1155RejectingReceiver {
    // No onERC1155Received — transfers to this contract must revert.
}

contract Erc1155AcceptingReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }
}

/// Arm A unit tests for IouToken beyond the referee suite: init guards,
/// ERC-1155 edge behavior, and the authorization surface's failure modes.
contract IouTokenArmTest is ArmBase {
    uint256 internal constant ISSUED = 1_000e6;
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        _certify(sarrafA);
        _addMember(sarrafA, memberA1);
        _issueBacked(sarrafA, memberA1, ISSUED);
        id = _id(sarrafA);
    }

    // ------------------------------------------------------------- init

    function test_init_onlyOnce() public {
        vm.expectRevert(bytes("IouToken: only deployer"));
        vm.prank(attacker);
        iou.init(attacker, attacker);

        // Even the deployer cannot re-wire after initialization.
        vm.expectRevert(bytes("IouToken: already initialized"));
        iou.init(address(pool), address(vault));
    }

    function test_minters_areExactlyPoolAndVault() public view {
        assertEq(iou.reservePool(), address(pool));
        assertEq(iou.noteVault(), address(vault));
    }

    // --------------------------------------------------------- ERC-1155

    function test_safeTransferFrom_requiresOwnershipOrApproval() public {
        vm.prank(attacker);
        vm.expectRevert(bytes("IouToken: not owner nor approved"));
        iou.safeTransferFrom(memberA1, attacker, id, 1e6, "");

        // Owner-approved operator may move the balance.
        vm.prank(memberA1);
        iou.setApprovalForAll(attacker, true);
        vm.prank(attacker);
        iou.safeTransferFrom(memberA1, recipient1, id, 1e6, "");
        assertEq(iou.balanceOf(recipient1, id), 1e6);

        // Revoked approval blocks again.
        vm.prank(memberA1);
        iou.setApprovalForAll(attacker, false);
        vm.prank(attacker);
        vm.expectRevert(bytes("IouToken: not owner nor approved"));
        iou.safeTransferFrom(memberA1, recipient1, id, 1e6, "");
    }

    function test_safeTransferFrom_toZeroOrOverBalance_reverts() public {
        vm.prank(memberA1);
        vm.expectRevert(bytes("IouToken: transfer to zero"));
        iou.safeTransferFrom(memberA1, address(0), id, 1e6, "");

        vm.prank(memberA1);
        vm.expectRevert(bytes("IouToken: insufficient balance"));
        iou.safeTransferFrom(memberA1, recipient1, id, ISSUED + 1, "");
    }

    function test_safeTransferFrom_receiverContractMustAccept() public {
        address rejecting = address(new Erc1155RejectingReceiver());
        vm.prank(memberA1);
        vm.expectRevert();
        iou.safeTransferFrom(memberA1, rejecting, id, 1e6, "");

        address accepting = address(new Erc1155AcceptingReceiver());
        vm.prank(memberA1);
        iou.safeTransferFrom(memberA1, accepting, id, 1e6, "");
        assertEq(iou.balanceOf(accepting, id), 1e6);
    }

    function test_safeBatchTransferFrom_movesAllIdsAtomically() public {
        _certify(sarrafB);
        _addMember(sarrafB, memberA2);
        _issueBacked(sarrafB, memberA2, 500e6);
        vm.prank(memberA2);
        iou.safeTransferFrom(memberA2, memberA1, _id(sarrafB), 500e6, "");

        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = _id(sarrafB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 100e6;
        amounts[1] = 200e6;

        vm.prank(memberA1);
        iou.safeBatchTransferFrom(memberA1, recipient1, ids, amounts, "");
        assertEq(iou.balanceOf(recipient1, id), 100e6);
        assertEq(iou.balanceOf(recipient1, _id(sarrafB)), 200e6);

        // Length mismatch reverts.
        uint256[] memory shortAmounts = new uint256[](1);
        shortAmounts[0] = 1;
        vm.prank(memberA1);
        vm.expectRevert(bytes("IouToken: length mismatch"));
        iou.safeBatchTransferFrom(memberA1, recipient1, ids, shortAmounts, "");
    }

    function test_balanceOfBatch_reportsPerPair() public view {
        address[] memory accounts = new address[](2);
        accounts[0] = memberA1;
        accounts[1] = recipient1;
        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = id;
        uint256[] memory bals = iou.balanceOfBatch(accounts, ids);
        assertEq(bals[0], ISSUED);
        assertEq(bals[1], 0);
    }

    function test_setApprovalForAll_selfApproval_reverts() public {
        vm.prank(memberA1);
        vm.expectRevert(bytes("IouToken: self approval"));
        iou.setApprovalForAll(memberA1, true);
    }

    function test_supportsInterface_erc165AndErc1155() public view {
        assertTrue(iou.supportsInterface(0x01ffc9a7));
        assertTrue(iou.supportsInterface(0xd9b67a26));
        assertFalse(iou.supportsInterface(0xffffffff));
    }

    // ---------------------------------------------- transferWithAuthorization

    function _authSig(
        uint256 pk,
        address from,
        address to,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        return _sign(
            pk, AuthLib.transferAuthDigest(address(iou), from, to, id, amount, validAfter, validBefore, nonce)
        );
    }

    function test_auth_badSignatureLength_reverts() public {
        vm.expectRevert(bytes("IouToken: bad signature length"));
        iou.transferWithAuthorization(
            memberA1, recipient1, id, 1e6, 0, block.timestamp + 1, "n", hex"deadbeef"
        );
    }

    function test_auth_highSMalleatedSignature_reverts() public {
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        bytes32 nonce = keccak256("malleable");
        bytes32 digest = AuthLib.transferAuthDigest(
            address(iou), memberA1, recipient1, id, 1e6, validAfter, validBefore, nonce
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(memberA1Pk, digest);
        // Malleate into the high-s twin (flip v, s' = n - s).
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleated = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));

        vm.expectRevert(bytes("IouToken: malleable signature"));
        iou.transferWithAuthorization(
            memberA1, recipient1, id, 1e6, validAfter, validBefore, nonce, malleated
        );
    }

    function test_auth_signatureBoundToEveryField() public {
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        bytes32 nonce = keccak256("bound");
        bytes memory sig = _authSig(memberA1Pk, memberA1, recipient1, 100e6, validAfter, validBefore, nonce);

        // Any mutated field must fail recovery against `from`.
        vm.expectRevert(bytes("IouToken: invalid signature"));
        iou.transferWithAuthorization(memberA1, recipient2, id, 100e6, validAfter, validBefore, nonce, sig);
        vm.expectRevert(bytes("IouToken: invalid signature"));
        iou.transferWithAuthorization(memberA1, recipient1, id, 101e6, validAfter, validBefore, nonce, sig);
        vm.expectRevert(bytes("IouToken: invalid signature"));
        iou.transferWithAuthorization(
            memberA1, recipient1, id, 100e6, validAfter, validBefore + 1, nonce, sig
        );

        // The untampered tuple still pays.
        iou.transferWithAuthorization(memberA1, recipient1, id, 100e6, validAfter, validBefore, nonce, sig);
        assertEq(iou.balanceOf(recipient1, id), 100e6);
    }

    function test_auth_domainBoundToThisContract() public {
        // A signature over an identical tuple for a DIFFERENT verifying
        // contract must not authorize a transfer here.
        IouToken other = new IouToken();
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        bytes32 nonce = keccak256("cross-domain");
        bytes memory foreignSig = _sign(
            memberA1Pk,
            AuthLib.transferAuthDigest(
                address(other), memberA1, recipient1, id, 1e6, validAfter, validBefore, nonce
            )
        );
        vm.expectRevert(bytes("IouToken: invalid signature"));
        iou.transferWithAuthorization(memberA1, recipient1, id, 1e6, validAfter, validBefore, nonce, foreignSig);
    }

    function test_auth_exactBoundaries() public {
        bytes32 nonce = keccak256("boundary");
        uint256 validAfter = block.timestamp; // not yet valid AT validAfter
        uint256 validBefore = block.timestamp + 10;
        bytes memory sig = _authSig(memberA1Pk, memberA1, recipient1, 1e6, validAfter, validBefore, nonce);

        vm.expectRevert(bytes("IouToken: authorization not yet valid"));
        iou.transferWithAuthorization(memberA1, recipient1, id, 1e6, validAfter, validBefore, nonce, sig);

        vm.warp(validBefore); // expired AT validBefore
        vm.expectRevert(bytes("IouToken: authorization expired"));
        iou.transferWithAuthorization(memberA1, recipient1, id, 1e6, validAfter, validBefore, nonce, sig);
    }

    function testFuzz_auth_nonceIsPerSigner(bytes32 nonce) public {
        // The same nonce value remains fresh for a different signer.
        _addMember(sarrafA, memberA2);
        _issueBacked(sarrafA, memberA2, 100e6);
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;

        bytes memory sig1 = _authSig(memberA1Pk, memberA1, recipient1, 5e6, validAfter, validBefore, nonce);
        iou.transferWithAuthorization(memberA1, recipient1, id, 5e6, validAfter, validBefore, nonce, sig1);

        bytes memory sig2 = _authSig(memberA2Pk, memberA2, recipient1, 7e6, validAfter, validBefore, nonce);
        iou.transferWithAuthorization(memberA2, recipient1, id, 7e6, validAfter, validBefore, nonce, sig2);

        assertEq(iou.balanceOf(recipient1, id), 12e6);
        assertTrue(iou.authorizationState(memberA1, nonce));
        assertTrue(iou.authorizationState(memberA2, nonce));
    }
}
