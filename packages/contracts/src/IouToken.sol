// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIouToken} from "dovizir-acceptance/interfaces/IDovizir.sol";
import {AuthLib} from "dovizir-acceptance/AuthLib.sol";

interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data)
        external
        returns (bytes4);

    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external returns (bytes4);
}

/// @title IouToken — issuer-tranched ERC-1155 IOU with EIP-3009-style authorizations
/// @notice One fungible token id per Sarraf (`id = uint256(uint160(sarraf))`),
/// implementing the frozen IIouToken interface:
///  - mint/burn restricted to the two authorized protocol contracts (ReservePool
///    and NoteVault), wired exactly once via {init};
///  - `transferWithAuthorization` verifies an EIP-712 signature under the frozen
///    AuthLib domain (name "Dovizir IOU", version "1") and is relayable by
///    anyone (courier mode) with a one-time nonce per signer.
/// ERC-1155 core is implemented self-contained (no external deps): balance /
/// approval bookkeeping, safe transfer receiver checks, ERC-165.
contract IouToken is IIouToken {
    // ------------------------------------------------------------- constants
    /// secp256k1 group order / 2 — reject malleable high-s signatures.
    uint256 internal constant _SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // --------------------------------------------------------------- storage
    address public immutable deployer;
    address public reservePool; // authorized minter/burner (set once)
    address public noteVault; // authorized minter/burner (set once)

    mapping(uint256 => mapping(address => uint256)) internal _balances;
    mapping(address => mapping(address => bool)) internal _operatorApprovals;
    /// EIP-3009 one-time nonces: from => nonce => used.
    mapping(address => mapping(bytes32 => bool)) internal _authorizationUsed;

    // ---------------------------------------------------------------- events
    event TransferSingle(
        address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value
    );
    event TransferBatch(
        address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values
    );
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One-time wiring of the two authorized protocol contracts.
    function init(address reservePool_, address noteVault_) external {
        require(msg.sender == deployer, "IouToken: only deployer");
        require(reservePool == address(0) && noteVault == address(0), "IouToken: already initialized");
        require(reservePool_ != address(0) && noteVault_ != address(0), "IouToken: zero address");
        reservePool = reservePool_;
        noteVault = noteVault_;
    }

    // ------------------------------------------------------------ mint/burn

    modifier onlyProtocol() {
        require(msg.sender == reservePool || msg.sender == noteVault, "IouToken: not authorized");
        _;
    }

    /// @inheritdoc IIouToken
    function mint(address to, uint256 trancheId, uint256 amount) external onlyProtocol {
        require(to != address(0), "IouToken: mint to zero");
        _balances[trancheId][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, trancheId, amount);
        _checkReceiver(msg.sender, address(0), to, trancheId, amount, "");
    }

    /// @inheritdoc IIouToken
    function burn(address from, uint256 trancheId, uint256 amount) external onlyProtocol {
        uint256 bal = _balances[trancheId][from];
        require(bal >= amount, "IouToken: burn exceeds balance");
        unchecked {
            _balances[trancheId][from] = bal - amount;
        }
        emit TransferSingle(msg.sender, from, address(0), trancheId, amount);
    }

    // -------------------------------------------------- EIP-3009 authorizations

    /// @inheritdoc IIouToken
    function transferWithAuthorization(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        require(block.timestamp > validAfter, "IouToken: authorization not yet valid");
        require(block.timestamp < validBefore, "IouToken: authorization expired");
        require(!_authorizationUsed[from][nonce], "IouToken: authorization reused");

        bytes32 digest =
            AuthLib.transferAuthDigest(address(this), from, to, id, amount, validAfter, validBefore, nonce);
        require(_recover(digest, signature) == from, "IouToken: invalid signature");

        _authorizationUsed[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _safeTransfer(msg.sender, from, to, id, amount, "");
    }

    /// @inheritdoc IIouToken
    function authorizationState(address from, bytes32 nonce) external view returns (bool used) {
        return _authorizationUsed[from][nonce];
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        require(signature.length == 65, "IouToken: bad signature length");
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        require(uint256(s) <= _SECP256K1_HALF_N, "IouToken: malleable signature");
        signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "IouToken: invalid signer");
    }

    // ----------------------------------------------------------- ERC-1155 core

    function balanceOf(address account, uint256 id) public view returns (uint256) {
        return _balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids)
        external
        view
        returns (uint256[] memory balances)
    {
        require(accounts.length == ids.length, "IouToken: length mismatch");
        balances = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) {
            balances[i] = _balances[ids[i]][accounts[i]];
        }
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "IouToken: self approval");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address account, address operator) public view returns (bool) {
        return _operatorApprovals[account][operator];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data)
        external
    {
        require(from == msg.sender || isApprovedForAll(from, msg.sender), "IouToken: not owner nor approved");
        _safeTransfer(msg.sender, from, to, id, amount, data);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external {
        require(from == msg.sender || isApprovedForAll(from, msg.sender), "IouToken: not owner nor approved");
        require(ids.length == amounts.length, "IouToken: length mismatch");
        require(to != address(0), "IouToken: transfer to zero");
        for (uint256 i; i < ids.length; ++i) {
            uint256 bal = _balances[ids[i]][from];
            require(bal >= amounts[i], "IouToken: insufficient balance");
            unchecked {
                _balances[ids[i]][from] = bal - amounts[i];
            }
            _balances[ids[i]][to] += amounts[i];
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
        if (to.code.length > 0) {
            require(
                IERC1155Receiver(to).onERC1155BatchReceived(msg.sender, from, ids, amounts, data)
                    == IERC1155Receiver.onERC1155BatchReceived.selector,
                "IouToken: receiver rejected"
            );
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0xd9b67a26; // ERC-1155
    }

    // ------------------------------------------------------------- internals

    function _safeTransfer(
        address operator,
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes memory data
    ) internal {
        require(to != address(0), "IouToken: transfer to zero");
        uint256 bal = _balances[id][from];
        require(bal >= amount, "IouToken: insufficient balance");
        unchecked {
            _balances[id][from] = bal - amount;
        }
        _balances[id][to] += amount;
        emit TransferSingle(operator, from, to, id, amount);
        _checkReceiver(operator, from, to, id, amount, data);
    }

    function _checkReceiver(
        address operator,
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes memory data
    ) internal {
        if (to.code.length > 0) {
            require(
                IERC1155Receiver(to).onERC1155Received(operator, from, id, amount, data)
                    == IERC1155Receiver.onERC1155Received.selector,
                "IouToken: receiver rejected"
            );
        }
    }
}
