// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAcceptanceDeployer, IMockUsdt, DovizirSystem} from "../interfaces/IAcceptanceDeployer.sol";
import {
    IIouToken, IMemberRegistry, IReservePool, IInsuranceFund, ISarrafRegistry, INoteVault
} from "../interfaces/IDovizir.sol";
import {Stub} from "../StubDeployer.sol";
import {AuthLib} from "../AuthLib.sol";

/// Arm B mock USDT: 6 decimals, open mint (IAcceptanceDeployer requirement).
contract MockUsdt {
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ALLOWANCE");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Arm B SarrafRegistry: certification via 7-day TWAB of deposit vs floor
/// (ISarrafRegistry). Balance history is fed by ReservePool via notifyBalance.
contract SarrafRegistry {
    event Certified(address indexed sarraf);
    event Decertified(address indexed sarraf);

    uint256 internal constant FLOOR_CAP = 1_000_000e6;
    uint256 internal constant WINDOW = 7 days;

    address public immutable deployerOwner;
    address public pool;

    uint256 public totalDeposits;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public balanceSince;
    mapping(address => bool) public isCertified;
    mapping(address => uint256) public lastEvalAt;
    mapping(address => uint256) public lowStreak;
    mapping(address => bool) public isAccepting;

    constructor() {
        deployerOwner = msg.sender;
    }

    function initialize(address pool_) external {
        require(msg.sender == deployerOwner && pool == address(0), "ALREADY_INIT");
        pool = pool_;
    }

    function notifyBalance(address sarraf, uint256 newBalance, uint256 newTotalDeposits) external {
        require(msg.sender == pool, "NOT_POOL");
        balanceOf[sarraf] = newBalance;
        balanceSince[sarraf] = block.timestamp;
        totalDeposits = newTotalDeposits;
    }

    function floor() public view returns (uint256) {
        uint256 byShare = totalDeposits / 5;
        return byShare < FLOOR_CAP ? byShare : FLOOR_CAP;
    }

    function twabOf(address sarraf) public view returns (uint256) {
        uint256 since = balanceSince[sarraf];
        if (since == 0) return 0;
        uint256 elapsed = block.timestamp - since;
        uint256 bal = balanceOf[sarraf];
        return elapsed >= WINDOW ? bal : (bal * elapsed) / WINDOW;
    }

    function evaluate() external {
        uint256 last = lastEvalAt[msg.sender];
        require(last == 0 || block.timestamp >= last + 1 days, "RATE_LIMIT");
        lastEvalAt[msg.sender] = block.timestamp;

        uint256 f = floor();
        uint256 twab = twabOf(msg.sender);
        if (!isCertified[msg.sender]) {
            if (twab >= f) {
                isCertified[msg.sender] = true;
                lowStreak[msg.sender] = 0;
                emit Certified(msg.sender);
            }
        } else if (twab < (f * 90) / 100) {
            lowStreak[msg.sender] += 1;
            if (lowStreak[msg.sender] >= 3) {
                isCertified[msg.sender] = false;
                lowStreak[msg.sender] = 0;
                emit Decertified(msg.sender);
            }
        } else {
            lowStreak[msg.sender] = 0;
        }
    }

    function setAccepting(bool accepting) external {
        isAccepting[msg.sender] = accepting;
    }
}

/// Arm B MemberRegistry: onboarding gated by SarrafRegistry certification.
contract MemberRegistry {
    event MemberAdded(address indexed member, address indexed sarraf);
    event MemberRehomed(address indexed member, address indexed fromSarraf, address indexed toSarraf);

    SarrafRegistry public immutable sarrafRegistry;
    mapping(address => address) public sarrafOf;

    constructor(address sarrafRegistry_) {
        sarrafRegistry = SarrafRegistry(sarrafRegistry_);
    }

    function addMember(address member) external {
        require(sarrafRegistry.isCertified(msg.sender), "NOT_CERTIFIED");
        require(sarrafOf[member] == address(0), "ALREADY_MEMBER");
        sarrafOf[member] = msg.sender;
        emit MemberAdded(member, msg.sender);
    }

    function removeMember(address member) external {
        require(sarrafOf[member] == msg.sender, "NOT_SPONSOR");
        sarrafOf[member] = address(0);
    }

    function isMember(address member) external view returns (bool) {
        return sarrafOf[member] != address(0);
    }

    function rehome(address member, address newSarraf) external {
        address old = sarrafOf[member];
        sarrafOf[member] = newSarraf;
        emit MemberRehomed(member, old, newSarraf);
    }
}

/// Arm B IouToken: issuer-tranched ERC-1155-shaped IOU (IIouToken).
/// Mint/burn restricted to the pool/vault set once via initialize().
contract IouToken {
    event AuthorizationUsed(address indexed from, bytes32 indexed nonce);

    address public immutable deployerOwner;
    address public pool;
    address public vault;

    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(address => mapping(bytes32 => bool)) public authorizationState_;

    constructor() {
        deployerOwner = msg.sender;
    }

    function initialize(address pool_, address vault_) external {
        require(msg.sender == deployerOwner && pool == address(0), "ALREADY_INIT");
        pool = pool_;
        vault = vault_;
    }

    modifier onlyMinter() {
        require(msg.sender == pool || msg.sender == vault, "NOT_AUTHORIZED");
        _;
    }

    function mint(address to, uint256 trancheId, uint256 amount) external onlyMinter {
        balanceOf[to][trancheId] += amount;
    }

    function burn(address from, uint256 trancheId, uint256 amount) external onlyMinter {
        require(balanceOf[from][trancheId] >= amount, "BALANCE");
        balanceOf[from][trancheId] -= amount;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "NOT_APPROVED");
        require(balanceOf[from][id] >= amount, "BALANCE");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
    }

    function authorizationState(address from, bytes32 nonce) external view returns (bool used) {
        return authorizationState_[from][nonce];
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
        require(!authorizationState_[from][nonce], "NONCE_USED");

        bytes32 digest =
            AuthLib.transferAuthDigest(address(this), from, to, id, amount, validAfter, validBefore, nonce);
        require(_recover(digest, signature) == from, "BAD_SIGNATURE");

        authorizationState_[from][nonce] = true;
        require(balanceOf[from][id] >= amount, "BALANCE");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;

        emit AuthorizationUsed(from, nonce);
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "BAD_SIG_LEN");
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

/// Arm B ReservePool: funded-only deposit/issue (IReservePool). redeem/migrate
/// land when their own acceptance files become the ratchet target.
contract ReservePool {
    event Deposited(address indexed sarraf, uint256 amount);
    event Issued(address indexed sarraf, address indexed to, uint256 amount);

    MockUsdt public immutable usdt;
    IouToken public immutable iou;
    SarrafRegistry public immutable sarrafRegistry;

    mapping(address => uint256) public backingOf;
    mapping(address => uint256) public outstandingOf;
    uint256 public totalDeposits;

    constructor(address usdt_, address iou_, address sarrafRegistry_) {
        usdt = MockUsdt(usdt_);
        iou = IouToken(iou_);
        sarrafRegistry = SarrafRegistry(sarrafRegistry_);
    }

    function deposit(uint256 usdtAmount) external {
        require(usdtAmount > 0, "ZERO_AMOUNT");
        usdt.transferFrom(msg.sender, address(this), usdtAmount);
        backingOf[msg.sender] += usdtAmount;
        totalDeposits += usdtAmount;
        sarrafRegistry.notifyBalance(msg.sender, backingOf[msg.sender], totalDeposits);
        emit Deposited(msg.sender, usdtAmount);
    }

    function issue(address to, uint256 amount) external {
        require(sarrafRegistry.isCertified(msg.sender), "NOT_CERTIFIED");
        require(backingOf[msg.sender] >= outstandingOf[msg.sender] + amount, "INSUFFICIENT_BACKING");
        outstandingOf[msg.sender] += amount;
        iou.mint(to, uint256(uint160(msg.sender)), amount);
        emit Issued(msg.sender, to, amount);
    }

    function redeem(address, uint256) external pure {
        revert("NOT_IMPLEMENTED");
    }

    function migrate(address, address, uint256) external pure {
        revert("NOT_IMPLEMENTED");
    }
}

/// Arm B deployer — wires fresh instances of the six Dovizir contracts per call.
/// InsuranceFund/NoteVault are still the frozen compile-check Stub until their
/// own acceptance files become the ratchet target.
contract ArmBDeployer is IAcceptanceDeployer {
    function deploy() external override returns (DovizirSystem memory system) {
        MockUsdt usdt = new MockUsdt();
        SarrafRegistry sarrafRegistry = new SarrafRegistry();
        MemberRegistry memberRegistry = new MemberRegistry(address(sarrafRegistry));
        IouToken iou = new IouToken();
        Stub insuranceFund = new Stub();
        Stub noteVault = new Stub();
        ReservePool pool = new ReservePool(address(usdt), address(iou), address(sarrafRegistry));

        sarrafRegistry.initialize(address(pool));
        iou.initialize(address(pool), address(noteVault));

        system = DovizirSystem({
            usdt: IMockUsdt(address(usdt)),
            iouToken: IIouToken(address(iou)),
            memberRegistry: IMemberRegistry(address(memberRegistry)),
            reservePool: IReservePool(address(pool)),
            insuranceFund: IInsuranceFund(address(insuranceFund)),
            sarrafRegistry: ISarrafRegistry(address(sarrafRegistry)),
            noteVault: INoteVault(address(noteVault))
        });
    }
}
