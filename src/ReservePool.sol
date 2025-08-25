// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFees {
    function treasury() external view returns (address);
    function issuanceFee() external view returns (uint256);
    function redemptionFee() external view returns (uint256);
}

contract ReservePool {
    IFees public fees;
    mapping(address => int256) public reserveBalance; // member => signed balance

    event Issued(address indexed member, address indexed to, uint256 amount);
    event Redeemed(address indexed member, address indexed holder, uint256 amount);
    event FeesCollected(bytes32 kind, uint256 amount, address indexed payer);
    event Deposited(address indexed member, uint256 amount);

    constructor(address _fees) { fees = IFees(_fees); }

    function deposit(address member, uint256 amount) external {
        reserveBalance[member] += int256(amount);
        emit Deposited(member, amount);
    }

    function issueIOU(address member, address to, uint256 amount) external payable {
        require(msg.value == fees.issuanceFee(), "FEE");
        (bool ok,) = payable(fees.treasury()).call{value: msg.value}("");
        require(ok, "TREASURY");
        emit FeesCollected("ISSUANCE", msg.value, msg.sender);
        reserveBalance[member] += int256(amount);
        emit Issued(member, to, amount);
        // MVP: you’ll mint a proper IOU ERC20 later
    }

    function redeem(address member, uint256 amount) external payable {
        require(msg.value == fees.redemptionFee(), "FEE");
        (bool ok,) = payable(fees.treasury()).call{value: msg.value}("");
        require(ok, "TREASURY");
        emit FeesCollected("REDEMPTION", msg.value, msg.sender);
        reserveBalance[member] -= int256(amount);
        emit Redeemed(member, msg.sender, amount);
        // MVP: simulate off-chain stablecoin transfer
    }

    receive() external payable {}
}