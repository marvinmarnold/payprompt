// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/LatchkeyBilling.sol";

/// @dev Minimal mock USDC that tracks transfer calls and can be configured to fail.
contract MockUSDC {
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public balanceOf;
    bool private _failTransfer;
    bool private _failTransferFrom;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external { allowance[msg.sender][spender] = amount; }
    function setFailTransfer(bool v) external { _failTransfer = v; }
    function setFailTransferFrom(bool v) external { _failTransferFrom = v; }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (_failTransfer) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (_failTransferFrom) return false;
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract LatchkeyBillingTest is Test {
    MockUSDC usdc;
    LatchkeyBilling billing;
    address treasury = address(0x1);
    address proxyAddr = address(0x2);
    address caller = address(0x3);
    address owner = address(0x4);

    function setUp() public {
        usdc = new MockUSDC();
        billing = new LatchkeyBilling(address(usdc), treasury, proxyAddr, owner);

        // Fund caller and approve the billing contract
        usdc.mint(caller, 10_000_000); // 10 USDC
        vm.prank(caller);
        usdc.approve(address(billing), type(uint256).max);
    }

    // --- Constructor guards ---

    function test_revertZeroUsdc() public {
        vm.expectRevert("usdc required");
        new LatchkeyBilling(address(0), treasury, proxyAddr, owner);
    }

    function test_revertZeroTreasury() public {
        vm.expectRevert("treasury required");
        new LatchkeyBilling(address(usdc), address(0), proxyAddr, owner);
    }

    function test_revertZeroProxy() public {
        vm.expectRevert("proxy required");
        new LatchkeyBilling(address(usdc), treasury, address(0), owner);
    }

    function test_revertZeroOwner() public {
        vm.expectRevert("owner required");
        new LatchkeyBilling(address(usdc), treasury, proxyAddr, address(0));
    }

    function test_initialRoles() public view {
        assertEq(billing.treasury(), treasury);
        assertEq(billing.proxy(), proxyAddr);
        assertEq(billing.owner(), owner);
        assertEq(billing.settled(caller), 0);
    }

    // --- onlyProxy ---

    function test_revertIfNotProxy() public {
        vm.expectRevert("not proxy");
        billing.pull(caller, 100_000);
    }

    // --- Fee-on-top math ---
    // `pull(caller, cumulativeService)`: the proxy passes the caller's cumulative *service* total
    // (what the provider charges). The contract charges the unsettled delta plus a 1% fee ON TOP:
    //   user pays delta + delta/100; proxy receives delta (== provider price); treasury receives delta/100.

    function test_pull_feeOnTop_100k() public {
        // service delta = 100,000 → fee = 1,000 (1% on top); user pays 101,000
        vm.prank(proxyAddr);
        billing.pull(caller, 100_000);

        assertEq(usdc.balanceOf(proxyAddr), 100_000);              // provider gets exactly the service price
        assertEq(usdc.balanceOf(treasury),  1_000);                // fee is 1% on top
        assertEq(usdc.balanceOf(caller),    10_000_000 - 101_000); // user paid service + fee
        assertEq(usdc.balanceOf(address(billing)), 0);             // contract holds nothing
        assertEq(billing.settled(caller), 100_000);
    }

    function test_pull_feeOnTop_zeroFee_smallDelta() public {
        // service delta = 99 → fee = 0 (integer division); user pays 99, all to proxy
        vm.prank(proxyAddr);
        billing.pull(caller, 99);

        assertEq(usdc.balanceOf(proxyAddr), 99);
        assertEq(usdc.balanceOf(treasury),  0);
        assertEq(usdc.balanceOf(caller),    10_000_000 - 99);
    }

    function test_pull_emitsEvent() public {
        // Pulled(caller, cumulativeService, delta, fee)
        vm.expectEmit(true, false, false, true);
        emit LatchkeyBilling.Pulled(caller, 100_000, 100_000, 1_000);
        vm.prank(proxyAddr);
        billing.pull(caller, 100_000);
    }

    // --- Cumulative settlement: only the unsettled delta is ever charged ---

    function test_pull_chargesOnlyDelta_onSecondCall() public {
        vm.prank(proxyAddr);
        billing.pull(caller, 100_000); // delta 100k, fee 1k

        vm.prank(proxyAddr);
        billing.pull(caller, 150_000); // cumulative 150k → delta 50k, fee 500

        assertEq(usdc.balanceOf(proxyAddr), 150_000);            // 100k + 50k service
        assertEq(usdc.balanceOf(treasury),  1_500);              // 1k + 500 fee
        assertEq(usdc.balanceOf(caller),    10_000_000 - 151_500);
        assertEq(billing.settled(caller),   150_000);
    }

    // --- Idempotency / replay protection: re-submitting the same or lower total is rejected ---

    function test_pull_revertsOnReplaySameTotal() public {
        vm.prank(proxyAddr);
        billing.pull(caller, 100_000);

        vm.prank(proxyAddr);
        vm.expectRevert("non-monotonic"); // duplicate retry: cumulative not greater than settled
        billing.pull(caller, 100_000);
    }

    function test_pull_revertsOnLowerTotal() public {
        vm.prank(proxyAddr);
        billing.pull(caller, 100_000);

        vm.prank(proxyAddr);
        vm.expectRevert("non-monotonic"); // overlapping stale snapshot
        billing.pull(caller, 50_000);
    }

    function test_pull_revertsOnZeroFirstCall() public {
        vm.prank(proxyAddr);
        vm.expectRevert("non-monotonic"); // 0 is not greater than the initial settled (0)
        billing.pull(caller, 0);
    }

    // --- Token failure propagation ---

    function test_revertInsufficientAllowance() public {
        vm.prank(caller);
        usdc.approve(address(billing), 0);

        vm.prank(proxyAddr);
        vm.expectRevert("allowance"); // MockUSDC reverts; real USDC returns false → "pull failed"
        billing.pull(caller, 100_000);
    }

    function test_revertOnTransferFromFailure() public {
        usdc.setFailTransferFrom(true);

        vm.prank(proxyAddr);
        vm.expectRevert("pull failed");
        billing.pull(caller, 100_000);
    }

    // --- Role rotation (recover from key compromise or token blocklisting) ---

    function test_setProxy_onlyOwner() public {
        vm.prank(address(0xdead));
        vm.expectRevert("not owner");
        billing.setProxy(address(0x9));
    }

    function test_setProxy_zeroReverts() public {
        vm.prank(owner);
        vm.expectRevert("proxy required");
        billing.setProxy(address(0));
    }

    function test_setProxy_rotatesAndOldProxyLosesAccess() public {
        address newProxy = address(0x9);

        vm.expectEmit(true, true, false, false);
        emit LatchkeyBilling.ProxyUpdated(proxyAddr, newProxy);
        vm.prank(owner);
        billing.setProxy(newProxy);
        assertEq(billing.proxy(), newProxy);

        // old proxy can no longer pull
        vm.prank(proxyAddr);
        vm.expectRevert("not proxy");
        billing.pull(caller, 100_000);

        // new proxy can, and receives the service amount
        vm.prank(newProxy);
        billing.pull(caller, 100_000);
        assertEq(usdc.balanceOf(newProxy), 100_000);
    }

    function test_setTreasury_onlyOwner() public {
        vm.prank(address(0xdead));
        vm.expectRevert("not owner");
        billing.setTreasury(address(0x9));
    }

    function test_setTreasury_zeroReverts() public {
        vm.prank(owner);
        vm.expectRevert("treasury required");
        billing.setTreasury(address(0));
    }

    function test_setTreasury_rotatesAndFeeFollows() public {
        address newTreasury = address(0x8);

        vm.expectEmit(true, true, false, false);
        emit LatchkeyBilling.TreasuryUpdated(treasury, newTreasury);
        vm.prank(owner);
        billing.setTreasury(newTreasury);

        vm.prank(proxyAddr);
        billing.pull(caller, 100_000);
        assertEq(usdc.balanceOf(newTreasury), 1_000);
        assertEq(usdc.balanceOf(treasury),    0);
    }

    function test_transferOwnership() public {
        address newOwner = address(0x7);

        vm.prank(address(0xdead));
        vm.expectRevert("not owner");
        billing.transferOwnership(newOwner);

        vm.prank(owner);
        vm.expectRevert("owner required");
        billing.transferOwnership(address(0));

        vm.expectEmit(true, true, false, false);
        emit LatchkeyBilling.OwnershipTransferred(owner, newOwner);
        vm.prank(owner);
        billing.transferOwnership(newOwner);
        assertEq(billing.owner(), newOwner);

        // old owner no longer has rights
        vm.prank(owner);
        vm.expectRevert("not owner");
        billing.setProxy(address(0x9));
    }
}
