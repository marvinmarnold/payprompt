// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/LatchkeyBilling.sol";

contract Deploy is Script {
    function run() external {
        address usdc     = vm.envAddress("USDC_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address proxy    = vm.envAddress("PROXY_ADDRESS");
        // OWNER_ADDRESS rotates proxy/treasury after deploy; keep it a cold key or multisig,
        // separate from the hot PROXY_ADDRESS. Required explicitly — no silent fallback to the
        // deployer, so the owner key is always a deliberate choice.
        address ownerAddr = vm.envAddress("OWNER_ADDRESS");

        require(usdc     != address(0), "USDC_ADDRESS required");
        require(treasury != address(0), "TREASURY_ADDRESS required");
        require(proxy    != address(0), "PROXY_ADDRESS required");
        require(ownerAddr != address(0), "OWNER_ADDRESS required");

        vm.startBroadcast();
        LatchkeyBilling billing = new LatchkeyBilling(usdc, treasury, proxy, ownerAddr);
        vm.stopBroadcast();

        console.log("LatchkeyBilling deployed at:", address(billing));
    }
}
