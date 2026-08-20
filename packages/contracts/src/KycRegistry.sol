// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {MemberRegistry} from "./MemberRegistry.sol";
import {SarrafRegistry} from "./SarrafRegistry.sol";

/// @title KycRegistry — attestation levels, never documents
/// @notice The on-chain footprint of the KYC tier model (mvp.md):
///
///   0  registration    OTP-verified contact          every consumer
///   1  legal identity  ID + selfie, local provider   above a threshold
///   2  shop            + address & business checks   sellers
///
/// What is stored is WHO vouched, at WHAT level, WHEN — three words. The
/// documents behind an attestation stay with the sarraf and their chosen
/// provider (§4: the interface is pluggable, the accountability is not).
/// Publishing them on a public chain would be the privacy failure this
/// protocol exists to avoid, so the interface cannot even express PII.
///
/// Accountability: only the sarraf who SPONSORS a member may vouch for them,
/// and only while certified — losing certification (the maintainer's tier-3
/// lever) also revokes the power to vouch. Tier-1 losses land on the voucher.
///
/// Enforcement of tier ceilings is desk/app-side in the pilot. The frozen
/// token interfaces cannot gain KYC gates without breaking the referee suite;
/// that is a deliberate boundary.
contract KycRegistry {
    uint8 public constant MAX_TIER = 2;

    struct Attestation {
        uint8 tier;
        address by;
        uint64 at;
    }

    MemberRegistry public immutable memberRegistry;
    SarrafRegistry public immutable sarrafRegistry;

    mapping(address => Attestation) internal _attestations;

    event Attested(address indexed member, uint8 tier, address indexed by);

    constructor(MemberRegistry memberRegistry_, SarrafRegistry sarrafRegistry_) {
        memberRegistry = memberRegistry_;
        sarrafRegistry = sarrafRegistry_;
    }

    /// @notice Vouch for a member at `tier`. Downgrades are ordinary
    /// attestations — KYC expires, re-checks fail, fraud emerges — and a
    /// re-attestation at the same tier refreshes the timestamp (annual
    /// re-verification leaves a visible trail).
    function attest(address member, uint8 tier) external {
        require(tier <= MAX_TIER, "Kyc: bad tier");
        require(memberRegistry.sarrafOf(member) == msg.sender, "Kyc: not their sarraf");
        require(sarrafRegistry.isCertified(msg.sender), "Kyc: not certified");
        _attestations[member] = Attestation({tier: tier, by: msg.sender, at: uint64(block.timestamp)});
        emit Attested(member, tier, msg.sender);
    }

    /// @notice A member's current tier. Unattested == 0: registration-only,
    /// which is exactly what OTP-verified onboarding grants.
    function tierOf(address member) external view returns (uint8) {
        return _attestations[member].tier;
    }

    function attestationOf(address member)
        external
        view
        returns (uint8 tier, address by, uint64 at)
    {
        Attestation storage a = _attestations[member];
        return (a.tier, a.by, a.at);
    }
}
