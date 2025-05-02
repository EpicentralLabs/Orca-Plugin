import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import BufferLayout from "buffer-layout";
import { AccountMetaData } from "@solana/spl-governance";
import React from "react";

// Orca Whirlpool Program ID
export const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
);

// Config account commonly used in Orca Whirlpool operations
const ORCA_WHIRLPOOL_CONFIG = new PublicKey(
  "FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR"
);

// This maps instruction types to their decoders and UI components
const ORCA_WHIRLPOOL_INSTRUCTIONS = {
  // For Splash Pool Creation instruction (discriminator may differ)
  1: {
    name: "Orca: Create Splash Pool",
    accounts: [
      { name: "Whirlpool Config" },
      { name: "Tokenizable" },
      { name: "Whirlpool" },
      { name: "Token Mint A" },
      { name: "Token Mint B" },
      { name: "Fee Tier" },
      { name: "Token Vault A" },
      { name: "Token Vault B" },
      { name: "Fee Authority" },
      { name: "Collect Protocol Fees Authority" },
      { name: "Reward Authority" },
      { name: "System Program" },
      { name: "Token Program" },
      { name: "Rent" },
    ],
    getDataUI: async (
      connection: Connection, 
      data: Uint8Array,
      accounts: AccountMetaData[]
    ) => {
      try {
        // Skip the instruction discriminator (first byte)
        // Note: Actual Orca instructions might use different encoding
        const initialPriceLayout = BufferLayout.struct([
          BufferLayout.nu64("initialPriceLow"),
          BufferLayout.nu64("initialPriceHigh")
        ]);
        
        // Decode the data starting after instruction discriminator
        const decoded = initialPriceLayout.decode(Buffer.from(data), 1) as {
          initialPriceLow: number;
          initialPriceHigh: number;
        };
        
        // Convert the decoded values to a price
        // Orca often uses square root price in X64 fixed point notation
        const initialPriceLow = new BN(decoded.initialPriceLow.toString());
        const initialPriceHigh = new BN(decoded.initialPriceHigh.toString());
        const initialPrice = new BN(initialPriceLow)
          .add(new BN(initialPriceHigh).shln(64))
          .toString();
        
        // Get token mints from accounts
        const tokenMintA = accounts[3]?.pubkey.toString() || "Unknown";
        const tokenMintB = accounts[4]?.pubkey.toString() || "Unknown";
        
        return (
          <>
            <div>
              <span className="font-bold">Token A Mint:</span> {tokenMintA}
            </div>
            <div>
              <span className="font-bold">Token B Mint:</span> {tokenMintB}
            </div>
            <div>
              <span className="font-bold">Initial Price:</span> {initialPrice}
            </div>
            <div className="text-sm italic mt-2">
              Creates a new Orca Splash Pool for the specified token pair
            </div>
          </>
        );
      } catch (e) {
        console.error("Error decoding Orca instruction:", e);
        return (
          <>
            <div>Failed to decode Orca Splash Pool creation instruction</div>
            <div>Error: {String(e)}</div>
          </>
        );
      }
    },
  },
  // Add other Orca instruction decoders here as needed
};

export const ORCA_PROGRAM_INSTRUCTIONS = {
  [ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()]: ORCA_WHIRLPOOL_INSTRUCTIONS,
}; 