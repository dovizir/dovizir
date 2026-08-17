// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Stub} from "../StubDeployer.sol";
import {IAcceptanceDeployer, IMockUsdt, IErc1155Core, DovizirSystem} from "../interfaces/IAcceptanceDeployer.sol";
import {
    IIouToken,
    IMemberRegistry,
    IReservePool,
    IInsuranceFund,
    ISarrafRegistry,
    INoteVault
} from "../interfaces/IDovizir.sol";
import {AuthLib} from "../AuthLib.sol";

contract MockUsdt is IMockUsdt {
    uint256 private _totalSupply;
    mapping(address => uint256) private _bal;
    mapping(address => mapping(address => uint256)) private _allow;

    function decimals() external pure returns (uint8) { return 6; }
    function totalSupply() external view returns (uint256) { return _totalSupply; }
    function balanceOf(address a) external view returns (uint256) { return _bal[a]; }
    function allowance(address o, address s) external view returns (uint256) { return _allow[o][s]; }
    function approve(address s, uint256 amt) external returns (bool) {
        _allow[msg.sender][s] = amt;
        return true;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        _bal[msg.sender] -= amt;
        _bal[to] += amt;
        return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        _allow[from][msg.sender] -= amt;
        _bal[from] -= amt;
        _bal[to] += amt;
        return true;
    }
    function mint(address to, uint256 amt) external {
        _bal[to] += amt;
        _totalSupply += amt;
    }
}

contract MemberRegistry is IMemberRegistry {
    mapping(address => address) private _sarrafOf;

    function addMember(address member) external {
        require(_sarrafOf[member] == address(0), "ALREADY_MEMBER");
        _sarrafOf[member] = msg.sender;
        emit MemberAdded(member, msg.sender);
    }
    function removeMember(address member) external {
        require(_sarrafOf[member] == msg.sender, "NOT_SPONSOR");
        _sarrafOf[member] = address(0);
    }
    function sarrafOf(address member) external view returns (address) { return _sarrafOf[member]; }
    function isMember(address member) external view returns (bool) { return _sarrafOf[member] != address(0); }
    function rehome(address member, address newSarraf) external {
        address old = _sarrafOf[member];
        _sarrafOf[member] = newSarraf;
        emit MemberRehomed(member, old, newSarraf);
    }
}

contract ReservePool is IReservePool {
    uint256 internal constant FLOOR_CAP = 1_000_000e6;

    IMockUsdt public immutable usdt;
    IMemberRegistry public immutable registry;
    IouToken public iou;
    SarrafRegistry public sarrafRegistry;
    mapping(address => uint256) private _backingOf;
    mapping(address => uint256) private _outstandingOf;
    uint256 public totalBacking;

    constructor(IMockUsdt _usdt, IMemberRegistry _registry) {
        usdt = _usdt;
        registry = _registry;
    }

    function wire(IouToken _iou, SarrafRegistry _sarrafRegistry) external {
        require(address(iou) == address(0), "ALREADY_WIRED");
        iou = _iou;
        sarrafRegistry = _sarrafRegistry;
    }
    function deposit(uint256 usdtAmount) external {
        usdt.transferFrom(msg.sender, address(this), usdtAmount);
        _backingOf[msg.sender] += usdtAmount;
        totalBacking += usdtAmount;
        emit Deposited(msg.sender, usdtAmount);
    }
    function issue(address to, uint256 amount) external {
        require(sarrafRegistry.isCertified(msg.sender), "NOT_CERTIFIED");
        require(registry.sarrafOf(to) == msg.sender, "NOT_YOUR_MEMBER");
        require(_backingOf[msg.sender] - _outstandingOf[msg.sender] >= amount, "INSUFFICIENT_BACKING");
        _outstandingOf[msg.sender] += amount;
        iou.mint(to, uint256(uint160(msg.sender)), amount);
        emit Issued(msg.sender, to, amount);
    }
    function redeem(address sarraf, uint256 amount) external {
        iou.burn(msg.sender, uint256(uint160(sarraf)), amount);
        _outstandingOf[sarraf] -= amount;
        emit Redeemed(sarraf, msg.sender, amount, 0);
    }
    function migrate(address, address, uint256) external pure { revert("NOT_IMPLEMENTED"); }
    function backingOf(address sarraf) external view returns (uint256) { return _backingOf[sarraf]; }
    function outstandingOf(address sarraf) external view returns (uint256) { return _outstandingOf[sarraf]; }
}

contract SarrafRegistry is ISarrafRegistry {
    uint256 internal constant FLOOR_CAP = 1_000_000e6;

    ReservePool public immutable pool;
    mapping(address => bool) private _certified;
    mapping(address => uint256) private _lowStreak;
    mapping(address => bool) private _accepting;

    constructor(ReservePool _pool) {
        pool = _pool;
    }

    function evaluate() external {
        address sarraf = msg.sender;
        uint256 tw = twabOf(sarraf);
        uint256 fl = floor();
        if (tw >= fl) {
            _lowStreak[sarraf] = 0;
            if (!_certified[sarraf]) {
                _certified[sarraf] = true;
                emit Certified(sarraf);
            }
        } else if (tw < (fl * 90) / 100) {
            _lowStreak[sarraf] += 1;
            if (_lowStreak[sarraf] >= 3 && _certified[sarraf]) {
                _certified[sarraf] = false;
                emit Decertified(sarraf);
            }
        }
    }
    function isCertified(address sarraf) external view returns (bool) { return _certified[sarraf]; }
    function floor() public view returns (uint256) {
        uint256 f = pool.totalBacking() / 5;
        return f < FLOOR_CAP ? f : FLOOR_CAP;
    }
    function twabOf(address sarraf) public view returns (uint256) { return pool.backingOf(sarraf); }
    function setAccepting(bool accepting_) external { _accepting[msg.sender] = accepting_; }
    function isAccepting(address sarraf) external view returns (bool) { return _accepting[sarraf]; }
}

contract IouToken is IIouToken, IErc1155Core {
    address public immutable pool;
    address public immutable vault;
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(address => mapping(bytes32 => bool)) private _authUsed;

    constructor(address _pool, address _vault) {
        pool = _pool;
        vault = _vault;
    }

    modifier onlyMinter() {
        require(msg.sender == pool || msg.sender == vault, "NOT_AUTHORIZED");
        _;
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) { return _balances[id][account]; }
    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
    }
    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _operatorApprovals[account][operator];
    }
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        require(from == msg.sender || _operatorApprovals[from][msg.sender], "NOT_APPROVED");
        _balances[id][from] -= amount;
        _balances[id][to] += amount;
    }
    function mint(address to, uint256 trancheId, uint256 amount) external onlyMinter { _balances[trancheId][to] += amount; }
    function burn(address from, uint256 trancheId, uint256 amount) external onlyMinter { _balances[trancheId][from] -= amount; }
    function authorizationState(address from, bytes32 nonce) external view returns (bool used) {
        return _authUsed[from][nonce];
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
    ) external {
        require(block.timestamp > validAfter, "TOO_EARLY");
        require(block.timestamp < validBefore, "EXPIRED");
        require(!_authUsed[from][nonce], "NONCE_USED");
        bytes32 digest =
            AuthLib.transferAuthDigest(address(this), from, to, id, amount, validAfter, validBefore, nonce);
        require(_recover(digest, signature) == from, "INVALID_SIGNATURE");
        _authUsed[from][nonce] = true;
        _balances[id][from] -= amount;
        _balances[id][to] += amount;
        emit AuthorizationUsed(from, nonce);
    }

    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "BAD_SIG_LEN");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        return ecrecover(digest, v, r, s);
    }
}

/// Arm B deployer — wires the arm-b IouToken subsystem; InsuranceFund and
/// NoteVault remain Stub until later iterations implement them.
contract ArmBDeployer is IAcceptanceDeployer {
    function deploy() external override returns (DovizirSystem memory system) {
        address vaultStub = address(new Stub());
        address fundStub = address(new Stub());

        MockUsdt usdt_ = new MockUsdt();
        MemberRegistry registry_ = new MemberRegistry();
        ReservePool pool_ = new ReservePool(usdt_, registry_);
        IouToken iou_ = new IouToken(address(pool_), vaultStub);
        SarrafRegistry sarrafRegistry_ = new SarrafRegistry(pool_);
        pool_.wire(iou_, sarrafRegistry_);

        system = DovizirSystem({
            usdt: usdt_,
            iouToken: iou_,
            memberRegistry: registry_,
            reservePool: pool_,
            insuranceFund: IInsuranceFund(fundStub),
            sarrafRegistry: sarrafRegistry_,
            noteVault: INoteVault(vaultStub)
        });
    }
}
