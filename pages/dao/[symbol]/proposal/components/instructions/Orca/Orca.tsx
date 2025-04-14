import { Connection, PublicKey } from '@solana/web3.js';
import { AccountMetaData } from '@solana/spl-governance';
import { useQuery, QueryClient } from '@tanstack/react-query'; // QueryClient might be needed if creating instance
import { TOKEN_PROGRAM_ID, AccountLayout, MintLayout } from '@solana/spl-token';
import { getMintDecimalAmountFromNatural } from '@tools/sdk/units'; // Assuming this utility exists and works
import React from 'react'; // Import React for JSX

// --- Orca Whirlpool Program ID ---
const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

// --- Helper Functions (Keep or adapt as needed) ---

/** HELPER: fetch a token account */
const fetchTokenAccount = async (connection: Connection, accountPk: PublicKey | null | undefined) => {
  if (!accountPk) return null;
  try {
    const info = await connection.getAccountInfo(accountPk);
    // Basic validation: check if info exists and owner is token program
    if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) {
      console.warn(`Account ${accountPk.toBase58()} is not owned by TOKEN_PROGRAM_ID`);
      return null;
    }
    // Ensure data length is sufficient for AccountLayout
    if (info.data.length !== AccountLayout.span) {
      console.warn(`Account ${accountPk.toBase58()} has incorrect data length for Token Account: ${info.data.length}`);
      return null; // Or handle differently if partial parsing is possible
    }
    const decoded = AccountLayout.decode(info.data);
    // Ensure mint is a valid PublicKey before creating new instance
    const mint = decoded.mint ? new PublicKey(decoded.mint) : null;
    return { ...decoded, mint };
  } catch (e) {
    console.error(`Failed to fetch or decode token account ${accountPk.toBase58()}:`, e);
    return null;
  }
};

/** HELPER: fetch a mint account */
const fetchMintInfo = async (connection: Connection, mintPk: PublicKey | null | undefined) => {
  if (!mintPk) return null;
  try {
    const info = await connection.getAccountInfo(mintPk);
    if (!info) {
      console.warn(`Mint account ${mintPk.toBase58()} not found.`);
      return null;
    }
    // Basic validation: check owner (should be system program for native mint, token program otherwise?) and length
    if (info.data.length !== MintLayout.span) {
      console.warn(`Account ${mintPk.toBase58()} has incorrect data length for Mint Account: ${info.data.length}`);
      return null;
    }
    // Check if owned by token program (unless it's native SOL mint potentially)
    // if (!info.owner.equals(TOKEN_PROGRAM_ID)) { ... }

    return MintLayout.decode(info.data);
  } catch (e) {
    console.error(`Failed to fetch or decode mint account ${mintPk.toBase58()}:`, e);
    return null;
  }
};

// --- Instruction Display Registry ---

/**
 * Registry to help decode and display Orca Whirlpool instructions in the UI.
 * Keys are instruction identifiers (discriminators), often the first 8 bytes of data.
 * NOTE: Replace placeholder keys (e.g., 'ix:createPool') with actual discriminators.
 * NOTE: Account names and getDataUI implementations are placeholders and need refinement.
 */
export const ORCA_WHIRLPOOL_INSTRUCTIONS = {
  [ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()]: {
    // --- createPool ---
    // TODO: Replace 'ix:createPool' with actual discriminator (e.g., Buffer.from([...]).toString('hex'))
    'ix:createPool': {
      name: 'Orca: Create Pool',
      accounts: [
        { name: 'Whirlpools Config' },
        { name: 'Pool Address (PDA)' },
        { name: 'Token Mint A' },
        { name: 'Token Mint B' },
        { name: 'Token Vault A' },
        { name: 'Token Vault B' },
        { name: 'Fee Tier' },
        { name: 'Funder (Wallet)' },
        { name: 'System Program' },
        { name: 'Token Program' },
        { name: 'Rent Sysvar' },
      ] as { name: string }[], // Add type assertion if needed by consuming code
      // Example basic UI - needs data decoding and actual fetching
      getDataUI: async (
        connection: Connection,
        data: Buffer | Uint8Array, // Use Buffer for easier slicing
        accounts: AccountMetaData[]
      ): Promise<JSX.Element> => {
        // Placeholder: Decode instruction data (e.g., tickSpacing, initialPrice)
        // const tickSpacing = Buffer.from(data).readUInt16LE(8); // Example offset - VERIFY
        // const initialSqrtPrice = new BN(Buffer.from(data).subarray(10, 10 + 16)); // Example offset - VERIFY

        // Basic display showing accounts involved
        return (
          <div>
            <p>Create Orca Whirlpool</p>
            {accounts.map((acc, idx) => (
              <div key={idx}>
                <span>{ORCA_WHIRLPOOL_INSTRUCTIONS[ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()]['ix:createPool'].accounts[idx]?.name || `Account ${idx + 1}`}: </span>
                <code>{acc.pubkey.toBase58()}</code>
              </div>
            ))}
            {/* TODO: Add decoded data display */}
            {/* <p>Tick Spacing: {tickSpacing}</p> */}
          </div>
        );
      },
    },

    // --- openPosition ---
    // TODO: Replace 'ix:openPosition' with actual discriminator
    'ix:openPosition': {
      name: 'Orca: Open Position',
      accounts: [
        { name: 'Funder (Wallet)' },
        { name: 'Position Owner' }, // Often same as Funder unless DAO context
        { name: 'Position Address (PDA)' },
        { name: 'Position Mint Address' },
        { name: 'Position Token Account' },
        { name: 'Whirlpool Address' },
        { name: 'Token Program' },
        { name: 'System Program' },
        { name: 'Rent Sysvar' },
        { name: 'Associated Token Program' },
        { name: 'Metadata Program' }, // If using token-metadata
        { name: 'Metadata Update Authority' }, // Often the funder
      ] as { name: string }[],
      // Example basic UI
      getDataUI: async (
        connection: Connection,
        data: Buffer | Uint8Array,
        accounts: AccountMetaData[]
      ): Promise<JSX.Element> => {
        // Placeholder: Decode instruction data (e.g., tickLowerIndex, tickUpperIndex, liquidity)
        // const tickLowerIndex = Buffer.from(data).readInt32LE(8); // Example offset - VERIFY
        // const tickUpperIndex = Buffer.from(data).readInt32LE(12); // Example offset - VERIFY
        // const liquidity = new BN(Buffer.from(data).subarray(16, 16 + 16)); // Example offset - VERIFY

        return (
          <div>
            <p>Open Orca Whirlpool Position</p>
            {accounts.map((acc, idx) => (
              <div key={idx}>
                <span>{ORCA_WHIRLPOOL_INSTRUCTIONS[ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()]['ix:openPosition'].accounts[idx]?.name || `Account ${idx + 1}`}: </span>
                <code>{acc.pubkey.toBase58()}</code>
              </div>
            ))}
            {/* TODO: Add decoded data display */}
            {/* <p>Tick Lower: {tickLowerIndex}, Tick Upper: {tickUpperIndex}</p> */}
            {/* <p>Liquidity: {liquidity.toString()}</p> */}
          </div>
        );
      },
    },

    // --- increaseLiquidity ---
    // TODO: Replace 'ix:increaseLiquidity' with actual discriminator
    'ix:increaseLiquidity': {
      name: 'Orca: Increase Liquidity',
      accounts: [
        { name: 'Whirlpool Address' },
        { name: 'Position Authority' },
        { name: 'Position Address (PDA)' },
        { name: 'Position Token Account' },
        { name: 'Token Owner Account A (Source)' }, // Wallet's or Authority's ATA
        { name: 'Token Owner Account B (Source)' }, // Wallet's or Authority's ATA
        { name: 'Token Vault A' },
        { name: 'Token Vault B' },
        { name: 'Tick Array Lower' },
        { name: 'Tick Array Upper' },
        { name: 'Token Program' },
      ] as { name: string }[],
      getDataUI: async (
        connection: Connection,
        data: Buffer | Uint8Array,
        accounts: AccountMetaData[]
      ): Promise<JSX.Element> => {
        // TODO: Decode liquidity, tokenMaxA, tokenMaxB from data
        return <div>Increase Liquidity (Details TBD)</div>;
      },
    },

    // --- decreaseLiquidity ---
    // TODO: Replace 'ix:decreaseLiquidity' with actual discriminator
    'ix:decreaseLiquidity': {
      name: 'Orca: Decrease Liquidity',
      accounts: [
        { name: 'Whirlpool Address' },
        { name: 'Position Authority' },
        { name: 'Position Address (PDA)' },
        { name: 'Position Token Account' },
        { name: 'Token Owner Account A (Destination)' }, // Authority's ATA
        { name: 'Token Owner Account B (Destination)' }, // Authority's ATA
        { name: 'Token Vault A' },
        { name: 'Token Vault B' },
        { name: 'Tick Array Lower' },
        { name: 'Tick Array Upper' },
        { name: 'Token Program' },
      ] as { name: string }[],
      getDataUI: async (
        connection: Connection,
        data: Buffer | Uint8Array,
        accounts: AccountMetaData[]
      ): Promise<JSX.Element> => {
        // TODO: Decode liquidity, tokenMinA, tokenMinB from data
        return <div>Decrease Liquidity (Details TBD)</div>;
      },
    },

    // --- collectFees ---
    // TODO: Replace 'ix:collectFees' with actual discriminator
    'ix:collectFees': {
      name: 'Orca: Collect Fees',
      accounts: [
        { name: 'Whirlpool Address' },
        { name: 'Position Authority' },
        { name: 'Position Address (PDA)' },
        { name: 'Position Token Account' },
        { name: 'Token Owner Account A (Destination)' }, // Authority's ATA
        { name: 'Token Owner Account B (Destination)' }, // Authority's ATA
        { name: 'Token Vault A' },
        { name: 'Token Vault B' },
        { name: 'Token Program' },
      ] as { name: string }[],
      getDataUI: async (
        connection: Connection,
        data: Buffer | Uint8Array,
        accounts: AccountMetaData[]
      ): Promise<JSX.Element> => {
        // NOTE: This instruction usually has no specific data payload
        return <div>Collect Fees (Details TBD)</div>;
      },
    },

    // --- collectReward ---
    // TODO: Replace 'ix:collectReward' with actual discriminator
    'ix:collectReward': {
      name: 'Orca: Collect Reward',
      accounts: [
        { name: 'Whirlpool Address' },
        { name: 'Position Authority' },
        { name: 'Position Address (PDA)' },
        { name: 'Position Token Account' },
        { name: 'Reward Owner Account (Destination)' }, // Authority's Reward ATA
        { name: 'Reward Vault' },
        { name: 'Token Program' },
      ] as { name: string }[],
      getDataUI: async (
        connection: Connection,
        data: Buffer | Uint8Array,
        accounts: AccountMetaData[]
      ): Promise<JSX.Element> => {
        // TODO: Decode rewardIndex from data
        return <div>Collect Reward (Details TBD)</div>;
      },
    },
    // NOTE: The harvestPositionInstructions SDK function likely combines
    // updateFeesAndRewards, collectFees, and collectReward instructions.
    // You might need entries for the individual instructions if they appear separately.

    // --- closePosition ---
    // TODO: Replace 'ix:closePosition' with actual discriminator
    'ix:closePosition': {
      name: 'Orca: Close Position',
      accounts: [
        { name: 'Position Authority' },
        { name: 'Receiver (Rent Lamports)' }, // Usually the Authority or Funder
        { name: 'Position Address (PDA)' },
        { name: 'Position Mint Address' },
        { name: 'Position Token Account' },
        { name: 'Token Program' },
      ] as { name: string }[],
      getDataUI: async (
        connection: Connection,
        data: Buffer | Uint8Array,
        accounts: AccountMetaData[]
      ): Promise<JSX.Element> => {
        // NOTE: This instruction usually has no specific data payload
        return <div>Close Position (Details TBD)</div>;
      },
    },

    // TODO: Add other Whirlpool instructions as needed (e.g., swap, updateFeesAndRewards)
  },
  // Add entries for other programs if needed
};

// Example of how a UI component might use this registry (conceptual)
/*
function InstructionDetails({ instruction }: { instruction: UiInstruction }) {
  const connection = useConnection(); // Get connection from context
  const [detailsUI, setDetailsUI] = useState<JSX.Element | null>(null);

  useEffect(() => {
    const decode = async () => {
      if (!instruction.serializedInstruction) return;

      try {
        const ix = // Deserialize instruction (e.g., using web3.js)
        const programId = ix.programId.toBase58();
        const registryEntry = ORCA_WHIRLPOOL_INSTRUCTIONS[programId];

        if (registryEntry) {
          // TODO: Extract discriminator from ix.data
          const discriminator = ix.data.subarray(0, 8).toString('hex'); // Example
          const ixInfo = registryEntry[discriminator];

          if (ixInfo && ixInfo.getDataUI) {
            // Assuming ix.keys matches the expected AccountMetaData structure
            const ui = await ixInfo.getDataUI(connection.current, ix.data, ix.keys);
            setDetailsUI(ui);
          } else {
             setDetailsUI(<div>Unknown instruction for {programId}</div>);
          }
        } else {
           setDetailsUI(<div>Unknown program: {programId}</div>);
        }
      } catch (e) {
         console.error("Failed to decode/display instruction:", e);
         setDetailsUI(<div>Error displaying instruction details.</div>);
      }
    };
    decode();
  }, [instruction, connection]);

  return detailsUI || <div>Loading instruction details...</div>;
}
*/
