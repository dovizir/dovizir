// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Fees {
    address public owner;
    address public treasury;
    uint256 public issuanceFee;   // in wei for MVP
    uint256 public redemptionFee; // in wei

    event ParamsUpdated(address treasury, uint256 issuanceFee, uint256 redemptionFee);

    constructor(address _treasury, uint256 _iss, uint256 _red) {
        owner = msg.sender;
        treasury = _treasury;
        issuanceFee = _iss;
        redemptionFee = _red;
    }
    modifier onlyOwner(){ require(msg.sender==owner,"OWNER"); _; }

    function setParams(address _treasury, uint256 _iss, uint256 _red) external onlyOwner {
        treasury = _treasury; issuanceFee=_iss; redemptionFee=_red;
        emit ParamsUpdated(treasury, issuanceFee, redemptionFee);
    }
}