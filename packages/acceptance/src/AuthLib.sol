// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AuthLib — canonical EIP-712 domain & typehash for IIouToken
/// transferWithAuthorization (FROZEN SPEC)
/// @notice IDovizir.sol specifies "an EIP-712 signature over
/// (from,to,id,amount,validAfter,validBefore,nonce)" but does not pin the
/// domain. The referee pins it here (recorded as a spec addition in
/// README.md): arms MUST verify signatures against exactly this domain and
/// typehash or the IouToken acceptance tests fail.
///
///  - EIP-712 domain: name "Dovizir IOU", version "1", chainId =
///    block.chainid, verifyingContract = the IouToken contract.
///  - Typehash: EIP-3009's TransferWithAuthorization extended with the
///    ERC-1155 tranche `id` (replacing `value` with `id, amount`).
///  - Signature format: 65-byte abi.encodePacked(r, s, v).
library AuthLib {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("Dovizir IOU");
    bytes32 internal constant VERSION_HASH = keccak256("1");
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 id,uint256 amount,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function domainSeparator(address iouToken) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, iouToken));
    }

    function transferAuthDigest(
        address iouToken,
        address from,
        address to,
        uint256 id,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, id, amount, validAfter, validBefore, nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(iouToken), structHash));
    }
}
