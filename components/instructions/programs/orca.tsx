import { Connection, PublicKey } from "@solana/web3.js";
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
  // For Splash Pool Creation 
  // The actual instruction discriminator may differ - this is an example
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
        // In a real implementation, you would decode the instruction data here
        // based on how Orca encodes its CreateSplashPool instruction
        
        // For example purposes, showing the account information
        return (
          <div className="flex flex-col gap-2">
            <div>
              <span className="font-bold">Token A:</span>{" "}
              {accounts[3]?.pubkey.toString()}
            </div>
            <div>
              <span className="font-bold">Token B:</span>{" "}
              {accounts[4]?.pubkey.toString()}
            </div>
            <div>
              <span className="font-bold">Whirlpool:</span>{" "}
              {accounts[2]?.pubkey.toString()}
            </div>
            <div>
              <span className="font-bold">Config:</span>{" "}
              {accounts[0]?.pubkey.toString()}
            </div>
            <div className="text-sm italic mt-2">
              Creates a new Orca Splash Pool for the specified token pair
            </div>
          </div>
        );
      } catch (e) {
        console.error("Error decoding Orca instruction:", e);
        return (
          <div>Failed to decode Orca Splash Pool creation instruction</div>
        );
      }
    },
  },
  // Add other Orca instruction decoders here as needed
};

export const ORCA_PROGRAM_INSTRUCTIONS = {
  [ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()]: ORCA_WHIRLPOOL_INSTRUCTIONS,
}; 