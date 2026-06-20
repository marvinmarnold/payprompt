// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Pull-payment billing contract for Latchkey.
/// Callers approve this contract once (ERC-20 approve); the proxy settles their off-chain
/// accrued service debt by submitting the caller's cumulative service total. No vault — the
/// contract holds no balances; every pull pays straight through to proxy and treasury.
///
/// Fee model — the 1% Tesser fee is charged ON TOP of the provider's price, not carved out of it:
///   - `cumulativeService` is the caller's lifetime service total (atomic USDC, fee-exclusive).
///   - delta = cumulativeService - settled[caller]  (must be strictly increasing; monotonic).
///   - fee   = delta / 100                          (1% of the service delta, added on top).
///   - the user pays delta + fee; the proxy receives exactly `delta` (the provider's price);
///     the treasury receives `fee`.
///
/// Idempotency — `settled[caller]` is a monotonic cumulative checkpoint. Re-submitting an
/// already-settled (or lower) total reverts, so honest retries, crash-recovery re-broadcasts,
/// and overlapping snapshots can never double-charge a caller.
///
/// Role rotation — `proxy` and `treasury` are owner-rotatable so a compromised proxy hot key or
/// a token-blocklisted recipient can be recovered without redeploying and re-collecting approvals.
contract LatchkeyBilling {
    IERC20  public immutable usdc;
    address public treasury;
    address public proxy;
    address public owner;

    /// Cumulative service amount (atomic units, fee-exclusive) settled per caller. Monotonic.
    mapping(address => uint256) public settled;

    event Pulled(address indexed caller, uint256 cumulativeService, uint256 delta, uint256 fee);
    event ProxyUpdated(address indexed oldProxy, address indexed newProxy);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyProxy() {
        require(msg.sender == proxy, "not proxy");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _usdc, address _treasury, address _proxy, address _owner) {
        require(_usdc     != address(0), "usdc required");
        require(_treasury != address(0), "treasury required");
        require(_proxy    != address(0), "proxy required");
        require(_owner    != address(0), "owner required");
        usdc     = IERC20(_usdc);
        treasury = _treasury;
        proxy    = _proxy;
        owner    = _owner;
    }

    /// @notice Settle a caller's cumulative service debt. 1% fee on top to treasury, service to proxy.
    /// @param caller            The caller whose debt is being settled.
    /// @param cumulativeService The caller's lifetime service total in atomic USDC (fee-exclusive),
    ///                          strictly greater than the last settled total.
    function pull(address caller, uint256 cumulativeService) external onlyProxy {
        uint256 prev = settled[caller];
        require(cumulativeService > prev, "non-monotonic");
        uint256 delta = cumulativeService - prev;
        uint256 fee = delta / 100;
        settled[caller] = cumulativeService; // effects before interactions
        require(usdc.transferFrom(caller, address(this), delta + fee), "pull failed");
        if (fee > 0) {
            require(usdc.transfer(treasury, fee), "fee transfer failed");
        }
        require(usdc.transfer(proxy, delta), "net transfer failed");
        emit Pulled(caller, cumulativeService, delta, fee);
    }

    // --- Admin: rotate roles to recover from key compromise or token blocklisting ---

    function setProxy(address newProxy) external onlyOwner {
        require(newProxy != address(0), "proxy required");
        emit ProxyUpdated(proxy, newProxy);
        proxy = newProxy;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "treasury required");
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner required");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
