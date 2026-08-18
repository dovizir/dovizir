// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIouToken} from "../../../acceptance/src/interfaces/IDovizir.sol";
import {IErc1155Core} from "../../../acceptance/src/interfaces/IAcceptanceDeployer.sol";
import {AuthLib} from "../../../acceptance/src/AuthLib.sol";

/// @dev Issuer-tranched ERC-1155-surface IOU (id = uint256(uint160(sarraf))).
/// Mint/burn restricted to the pool and vault, wired once by the deployer.
contract IouToken is IIouToken, IErc1155Core {
    address private immutable _deployer;
    bool private _wired;
    address public pool;
    address public vault;

    mapping(address => mapping(uint256 => uint256)) public override balanceOf;
    mapping(address => mapping(address => bool)) public override isApprovedForAll;
    mapping(address => mapping(bytes32 => bool)) public override authorizationState;

    constructor() {
        _deployer = msg.sender;
    }

    function setMinters(address pool_, address vault_) external {
        require(msg.sender == _deployer && !_wired, "IouToken: wiring locked");
        _wired = true;
        pool = pool_;
        vault = vault_;
    }

    function mint(address to, uint256 trancheId, uint256 amount) external override {
        require(msg.sender == pool || msg.sender == vault, "IouToken: not authorized");
        balanceOf[to][trancheId] += amount;
    }

    function burn(address from, uint256 trancheId, uint256 amount) external override {
        require(msg.sender == pool || msg.sender == vault, "IouToken: not authorized");
        require(balanceOf[from][trancheId] >= amount, "IouToken: burn balance");
        balanceOf[from][trancheId] -= amount;
    }

    function setApprovalForAll(address operator, bool approved) external override {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata)
        external
        override
    {
        require(msg.sender == from || isApprovedForAll[from][msg.sender], "IouToken: not approved");
        require(balanceOf[from][id] >= amount, "IouToken: balance");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external override {
        require(block.timestamp > validAfter, "IouToken: not yet valid");
        require(block.timestamp < validBefore, "IouToken: expired");
        require(!authorizationState[from][nonce], "IouToken: nonce used");

        bytes32 digest =
            AuthLib.transferAuthDigest(address(this), from, to, id, amount, validAfter, validBefore, nonce);
        require(_recover(digest, signature) == from, "IouToken: bad signature");

        authorizationState[from][nonce] = true;
        require(balanceOf[from][id] >= amount, "IouToken: balance");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
        emit AuthorizationUsed(from, nonce);
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        require(signature.length == 65, "IouToken: bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return ecrecover(digest, v, r, s);
    }
}
