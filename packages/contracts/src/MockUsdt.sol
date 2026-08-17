// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title MockUsdt — 6-decimal mock ERC-20 with an OPEN mint (test/acceptance only)
/// @notice Satisfies IMockUsdt from the referee's IAcceptanceDeployer: standard
/// ERC-20 surface, `decimals() == 6`, `mint(address,uint256)` callable by any
/// address so test suites can fund arbitrary actors. Never deploy to a real
/// network as money.
contract MockUsdt {
    string public constant name = "Mock USDT";
    string public constant symbol = "mUSDT";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice OPEN mint — intentionally unpermissioned (referee requirement).
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MockUsdt: insufficient allowance");
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "MockUsdt: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
