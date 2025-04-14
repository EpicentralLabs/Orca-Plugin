import { useContext, useEffect, useState } from 'react';
import * as yup from 'yup';
import {
  ProgramAccount,
  Governance,
  serializeInstructionToBase64,
} from '@solana/spl-governance';
import { validateInstruction } from '@utils/instructionTools';
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes';
import {
  PublicKey,
  Connection,
  TransactionInstruction as Web3jsTransactionInstruction, // Alias for clarity
  Keypair,
  Transaction,
  ConfirmOptions,
  SystemProgram,
  AccountInfo,
} from '@solana/web3.js';
import { NewProposalContext } from '../../../new';
import InstructionForm, { InstructionInput } from '../FormCreator';
import { InstructionInputType } from '../inputInstructionType';
import { AssetAccount } from '@utils/uiTypes/assets';
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'; // Your existing web3.js wallet hook
import { useRealmQuery } from '@hooks/queries/realm';
import useGovernanceAssets from '@hooks/useGovernanceAssets';
import useLegacyConnectionContext from '@hooks/useLegacyConnectionContext'; // Your existing web3.js connection hook

// --- Import from NEWER Orca SDK ---
import {
  decreaseLiquidityInstructions, // Correct function for removing liquidity
  setWhirlpoolsConfig,
} from '@orca-so/whirlpools';

// --- Import from @solana/kit for RPC and Address ---
import { createSolanaRpc } from '@solana/kit'; // Use kit's RPC creator
import { Address } from '@solana/addresses'; // Newer SDK uses Address type (branded string)

// --- Import supporting types/libs ---
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// --- Form State Interface ---
interface RemoveLiquidityForm {
  governedAccount?: AssetAccount; // Represents the authority over the position NFT
  positionMint: string;          // Mint of the existing position NFT
  tokenAAmountToRemove: string;  // Amount of token A to remove (specify only one)
  tokenBAmountToRemove: string;  // Amount of token B to remove (specify only one)
  slippageBps: number;           // Slippage tolerance
}

// Helper: Parse PublicKey from account data buffer at a given offset
function parsePublicKeyFromBuffer(buffer: Buffer, offset: number): PublicKey | null {
  if (offset < 0 || buffer.length < offset + 32) return null;
  return new PublicKey(buffer.subarray(offset, offset + 32));
}

// Helper to convert UI amount (string) to bigint based on mint decimals (manual parsing)
async function uiAmountToBigInt(
  connection: Connection,
  amount: string,
  mint: PublicKey // Ensure mint is not null when calling
): Promise<bigint> {
  try {
    const mintAccountInfo = await connection.getAccountInfo(mint);
    if (!mintAccountInfo) throw new Error(`Mint account not found: ${mint.toBase58()}`);
    if (mintAccountInfo.data.length < 82) throw new Error(`Mint account data length too short: ${mintAccountInfo.data.length}`);
    const decimals = mintAccountInfo.data.readUInt8(44); // Decimals at offset 44
    const amountDecimal = new Decimal(amount || '0');
    const baseAmount = amountDecimal.mul(new Decimal(10).pow(decimals));
    return BigInt(baseAmount.toFixed(0));
  } catch (error) {
    console.error("Error converting amount to BigInt:", error);
    throw new Error(`Failed to convert amount "${amount}" for mint ${mint?.toBase58()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- React Component ---
export default function RemoveLiquidity({
                                          index,
                                          governance,
                                        }: {
  index: number;
  governance: ProgramAccount<Governance> | null;
}) {
  // --- Hooks ---
  const { handleSetInstructions } = useContext(NewProposalContext);
  const connection = useLegacyConnectionContext(); // Your web3.js connection
  const realm = useRealmQuery().data?.result;
  const { assetAccounts } = useGovernanceAssets();
  const wallet = useWalletOnePointOh(); // Your web3.js wallet adapter

  // --- State ---
  const [form, setForm] = useState<RemoveLiquidityForm>({
    governedAccount: undefined,
    positionMint: '',
    tokenAAmountToRemove: '0',
    tokenBAmountToRemove: '0',
    slippageBps: 50, // Default 0.5%
  });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance);

  // --- Validation Schema ---
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required('Governance account (Position Authority) is required'),
    positionMint: yup
      .string()
      .required('Position NFT Mint address is required')
      .test('is-pubkey', 'Invalid Position Mint address', (value) => {
        try { new PublicKey(value || ''); return true; } catch (e) { return false; }
      }),
    tokenAAmountToRemove: yup
      .string()
      .test('is-positive-or-zero', 'Amount must be >= 0', (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) >= 0)
      .required('Token A amount is required'),
    tokenBAmountToRemove: yup
      .string()
      .test('is-positive-or-zero', 'Amount must be >= 0', (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) >= 0)
      .required('Token B amount is required'),
    // Require exactly one amount > 0
    tokenInputLogic: yup.mixed().test(
      'exactly-one-token-amount-provided',
      'Provide amount for Token A OR Token B to remove (not both)',
      function() {
        const amountA = parseFloat(this.parent.tokenAAmountToRemove || '0');
        const amountB = parseFloat(this.parent.tokenBAmountToRemove || '0');
        // Exactly one must be positive
        return (amountA > 0 && amountB === 0) || (amountA === 0 && amountB > 0);
      }
    ),
    slippageBps: yup
      .number()
      .transform((value) => (isNaN(value) ? 0 : value))
      .min(0)
      .max(10000)
      .required('Slippage is required'),
  });

  // --- getInstruction Implementation ---
  async function getInstruction(): Promise<UiInstruction> {
    setFormErrors({});
    const isValid = await validateInstruction({ schema, form, setFormErrors });
    const prerequisiteInstructions: Web3jsTransactionInstruction[] = [];
    const prerequisiteInstructionsSigners: Keypair[] = [];
    const additionalSerializedInstructions: string[] = [];

    if (
      !isValid ||
      !form.governedAccount?.governance?.account ||
      !form.governedAccount?.extensions.transferAddress || // Authority address
      !wallet?.publicKey || // Funder wallet
      !connection.current
    ) {
      if (!form.governedAccount?.extensions.transferAddress && form.governedAccount) {
        setFormErrors(prev => ({...prev, governedAccount: 'Selected governed account does not have a valid authority address.' }));
      }
      if (!wallet?.connected) {
        setFormErrors(prev => ({...prev, _error: 'Wallet not connected.' }));
      }
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions, prerequisiteInstructionsSigners, additionalSerializedInstructions: [] };
    }

    let tokenMintA: PublicKey | null = null;
    let tokenMintB: PublicKey | null = null;

    try {
      // --- Authority & Funder ---
      const positionAuthority = form.governedAccount.extensions.transferAddress;
      const funderWallet = wallet;

      // --- Set Whirlpools Config ---
      const ORCA_WHIRLPOOL_PROGRAM_ID_PUBKEY = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"); // Mainnet ID
      await setWhirlpoolsConfig('solanaMainnet');

      // --- Create RPC Client ---
      const rpc = createSolanaRpc(connection.current.rpcEndpoint);

      // --- Prepare Position Mint & Derive Position PDA ---
      const positionMintPubKey = new PublicKey(form.positionMint);
      const [positionAddress] = await PublicKey.findProgramAddress(
        [Buffer.from("position"), positionMintPubKey.toBuffer()],
        ORCA_WHIRLPOOL_PROGRAM_ID_PUBKEY
      );
      console.log(`Position PDA address: ${positionAddress.toBase58()}`);

      // --- Fetch Position Account Data ---
      console.log(`Fetching position account info for PDA: ${positionAddress.toBase58()}`);
      const positionAccountInfo = await connection.current.getAccountInfo(positionAddress);
      if (!positionAccountInfo) {
        throw new Error(`Position account (PDA) not found for mint: ${positionMintPubKey.toBase58()}`);
      }
      // Parse necessary fields (authority, pool address) - VERIFY OFFSETS
      const fetchedAuthority = parsePublicKeyFromBuffer(positionAccountInfo.data, 40);
      const poolPublicKey = parsePublicKeyFromBuffer(positionAccountInfo.data, 8);

      if (!fetchedAuthority || !poolPublicKey) throw new Error("Failed to parse position data.");
      if (!fetchedAuthority.equals(positionAuthority)) throw new Error(`Account authority mismatch.`);
      console.log(`Position verified. Pool address: ${poolPublicKey.toBase58()}`);

      // --- Fetch Pool Account Data ---
      console.log(`Fetching pool account info for ${poolPublicKey.toBase58()}`);
      const poolAccountInfo = await connection.current.getAccountInfo(poolPublicKey);
      if (!poolAccountInfo) throw new Error(`Pool account not found: ${poolPublicKey.toBase58()}`);
      if (poolAccountInfo.data.length < 173 + 32) throw new Error("Pool account data too short.");
      // Parse mints - VERIFY OFFSETS
      tokenMintA = parsePublicKeyFromBuffer(poolAccountInfo.data, 93);
      tokenMintB = parsePublicKeyFromBuffer(poolAccountInfo.data, 173);
      if (!tokenMintA || !tokenMintB) throw new Error("Failed to parse token mints from pool data.");
      console.log(`Extracted Mints - A: ${tokenMintA.toBase58()}, B: ${tokenMintB.toBase58()}`);

      // --- Prepare SDK Parameters ---
      // SDK expects amount to remove specified by EITHER tokenA OR tokenB OR liquidity amount
      const param: { tokenA?: bigint; tokenB?: bigint; liquidity?: bigint } = {};
      const amountA = parseFloat(form.tokenAAmountToRemove || '0');
      const amountB = parseFloat(form.tokenBAmountToRemove || '0');

      // Based on validation, exactly one of these will be true
      if (amountA > 0) {
        param.tokenA = await uiAmountToBigInt(connection.current, form.tokenAAmountToRemove, tokenMintA);
      } else if (amountB > 0) {
        param.tokenB = await uiAmountToBigInt(connection.current, form.tokenBAmountToRemove, tokenMintB);
      } else {
        // Should be caught by validation
        throw new Error("Validation Error: Exactly one token amount to remove must be greater than zero.");
      }

      const slippageBps = form.slippageBps;
      const positionMintAddress = form.positionMint as Address;

      // --- Wallet for SDK (Funder) ---
      if (!funderWallet.signTransaction || !funderWallet.publicKey) {
        throw new Error("Connected wallet doesn't have publicKey or signTransaction method.");
      }
      const funderSigner = funderWallet as any; // Cast funder wallet

      // --- Call the Newer SDK function ---
      console.log(`Calling decreaseLiquidityInstructions for position mint: ${positionMintAddress}`);
      console.log(`Params: ${JSON.stringify(param)}`); // Param specifies amount to remove
      console.log(`Slippage: ${slippageBps}`);
      console.log(`Funder (passing wallet directly): ${funderWallet?.publicKey?.toBase58()}`);
      console.log(`Position Authority (governed account): ${positionAuthority.toBase58()}`);

      // The 'wallet' param acts as the funder.
      // The positionAuthority check relies on SPL Gov signature during execution.
      const {
        instructions: kitInstructions,
        // quote // Optional return value
      } = await decreaseLiquidityInstructions(
        rpc,
        positionMintAddress,
        param as any, // Cast param to bypass potential strict typing issues like IncreaseLiquidityQuoteParam
        slippageBps,
        funderSigner // Pass funder wallet (cast as any)
      );

      console.log(`Received ${kitInstructions.length} instructions from SDK.`);

      // --- Attempt to Convert/Cast Instructions (RISKY) ---
      const web3JsInstructions = kitInstructions as unknown as Web3jsTransactionInstruction[];
      console.warn("Attempting to cast @solana/transactions instructions to @solana/web3.js format. This might fail if structures differ significantly.");

      // --- Serialize Instructions ---
      const finalInstructions = [...prerequisiteInstructions, ...web3JsInstructions];
      finalInstructions.forEach((ix, idx) => {
        if (!ix || !ix.keys || !ix.programId) {
          console.error("Instruction structure seems invalid after casting:", ix);
          throw new Error(`Instruction at index ${idx} has invalid structure after casting.`);
        }
        console.log(`Serializing instruction ${idx + 1}/${finalInstructions.length}`);
        additionalSerializedInstructions.push(serializeInstructionToBase64(ix));
      });

      console.log('Instructions serialized successfully.');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      console.error('Error creating Orca remove liquidity instruction:', error);
      // Add specific error messages
      if (errorMessage.includes("Position account (PDA) not found")) {
        setFormErrors({ positionMint: errorMessage });
      } else if (errorMessage.includes("authority mismatch")) {
        setFormErrors({ governedAccount: errorMessage });
      } else if (errorMessage.includes("Pool account not found")) {
        setFormErrors({ _error: `Failed to find pool for position: ${errorMessage}` });
      } else if (errorMessage.includes("parse") || errorMessage.includes("offset")) {
        setFormErrors({ _error: `Failed to parse account data: ${errorMessage}` });
      } else if (errorMessage.includes("amount conversion") || errorMessage.includes("Mint account not found")) {
        setFormErrors({ tokenAAmountToRemove: errorMessage, tokenBAmountToRemove: errorMessage });
      } else if (errorMessage.includes("signTransaction")) {
        setFormErrors({ _error: `Wallet signing function might be incompatible: ${errorMessage}` });
      } else if (errorMessage.includes("serializeInstructionToBase64") || errorMessage.includes("invalid structure")) {
        setFormErrors({ _error: `Failed to serialize instructions - format mismatch likely: ${errorMessage}` });
      } else {
        setFormErrors({ _error: `Failed to create instruction: ${errorMessage}` });
      }
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions: [], prerequisiteInstructionsSigners: [], additionalSerializedInstructions: [] };
    }

    // --- Return UiInstruction ---
    return {
      serializedInstruction: '', // Keep empty as per pattern
      isValid: true,
      governance: form.governedAccount?.governance,
      prerequisiteInstructions: [],
      prerequisiteInstructionsSigners,
      additionalSerializedInstructions,
      chunkBy: 2, // Adjust chunk size as needed
    };
  }

  // --- Form Inputs Definition ---
  const inputs: InstructionInput[] = [
    {
      label: 'Position Authority (Governance Account)',
      initialValue: form.governedAccount,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts.filter(acc => !!acc.extensions.transferAddress),
    },
    {
      label: 'Position NFT Mint Address',
      initialValue: form.positionMint,
      name: 'positionMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Token A Amount to Remove',
      initialValue: form.tokenAAmountToRemove,
      name: 'tokenAAmountToRemove',
      type: InstructionInputType.INPUT,
      inputType: 'text', // Use text for Decimal/BN precision
    },
    {
      label: 'Token B Amount to Remove',
      initialValue: form.tokenBAmountToRemove,
      name: 'tokenBAmountToRemove',
      type: InstructionInputType.INPUT,
      inputType: 'text', // Use text for Decimal/BN precision
    },
    {
      label: 'Acceptable Slippage (BPS)',
      initialValue: form.slippageBps,
      name: 'slippageBps',
      type: InstructionInputType.INPUT,
      inputType: 'number',
      step: 1,
    }
  ];

  // --- useEffect to Register Instruction ---
  useEffect(() => {
    handleSetInstructions(
      {
        governedAccount: form.governedAccount?.governance,
        getInstruction,
      },
      index
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, governance, index, handleSetInstructions]); // Include all dependencies

  // --- Render Component ---
  return (
    <InstructionForm
      outerForm={form}
      setForm={setForm}
      inputs={inputs}
      setFormErrors={setFormErrors}
      formErrors={formErrors}
    />
  );
}
