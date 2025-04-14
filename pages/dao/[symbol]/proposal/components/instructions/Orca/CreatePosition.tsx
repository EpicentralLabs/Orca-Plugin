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
  Transaction, // Keep web3.js Transaction type
  ConfirmOptions,
  SystemProgram,
  AccountInfo,
  VersionedTransaction,
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
  openPositionInstructions, // For concentrated liquidity
  openFullRangePositionInstructions, // For "Splash" like full range
  setWhirlpoolsConfig, // Function to set config address (devnet/mainnet)
} from '@orca-so/whirlpools';

// --- Import from @solana/kit for RPC and Address ---
import { createSolanaRpc } from '@solana/kit'; // Use kit's RPC creator
import { Address } from '@solana/addresses'; // Newer SDK uses Address type (branded string)

// --- Import supporting types/libs ---
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';
// Removed getMint import from @solana/spl-token
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// --- Form State Interface ---
interface CreatePositionForm {
  governedAccount?: AssetAccount; // The owner of the position NFT
  poolAddress: string;
  tokenAAmount: string; // Use string for UI input, convert to bigint
  tokenBAmount: string; // Use string for UI input, convert to bigint
  lowerPrice: string; // Use string for UI input, parse to number
  upperPrice: string; // Use string for UI input, parse to number
  slippageBps: number; // Basis points (e.g., 50 for 0.5%)
  isFullRange: boolean; // Replaces 'splash'
}

// Helper to convert UI amount (string) to bigint based on mint decimals
// Uses manual parsing of Mint account data instead of getMint
async function uiAmountToBigInt(
  connection: Connection,
  amount: string,
  mint: PublicKey // Ensure mint is not null when calling
): Promise<bigint> {
  try {
    console.log(`Fetching account info for mint: ${mint.toBase58()}`);
    const mintAccountInfo = await connection.getAccountInfo(mint);
    if (!mintAccountInfo) {
      throw new Error(`Mint account not found: ${mint.toBase58()}`);
    }
    if (mintAccountInfo.data.length < 82) { // Mint layout size is 82 bytes
      throw new Error(`Mint account data length too short: ${mintAccountInfo.data.length}`);
    }
    // Decimals field is a single byte at offset 44
    const decimals = mintAccountInfo.data.readUInt8(44);
    console.log(`Decimals for mint ${mint.toBase58()}: ${decimals}`);

    const amountDecimal = new Decimal(amount || '0');
    const baseAmount = amountDecimal.mul(new Decimal(10).pow(decimals));
    return BigInt(baseAmount.toFixed(0));
  } catch (error) {
    console.error("Error converting amount to BigInt:", error);
    throw new Error(`Failed to convert amount "${amount}" for mint ${mint?.toBase58()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}


// --- React Component ---
export default function CreatePosition({
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
  const [form, setForm] = useState<CreatePositionForm>({
    governedAccount: undefined,
    poolAddress: '',
    tokenAAmount: '0',
    tokenBAmount: '0',
    lowerPrice: '0',
    upperPrice: '0',
    isFullRange: false,
    slippageBps: 50, // Default 0.5%
  });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance);

  // --- Validation Schema ---
  // (Schema remains the same)
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required('Governance account (Position Owner) is required'),
    poolAddress: yup
      .string()
      .required('Pool address is required')
      .test('is-pubkey', 'Invalid Pool address', (value) => {
        try { new PublicKey(value || ''); return true; } catch (e) { return false; }
      }),
    tokenAAmount: yup
      .string()
      .test('is-positive-or-zero', 'Amount must be >= 0', (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) >= 0)
      .required('Token A amount is required'),
    tokenBAmount: yup
      .string()
      .test('is-positive-or-zero', 'Amount must be >= 0', (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) >= 0)
      .required('Token B amount is required'),
    tokenInputLogic: yup.mixed().test(
      'one-token-amount-provided',
      'Provide amount for Token A OR Token B (not both, unless one is 0)',
      function() {
        const amountA = parseFloat(this.parent.tokenAAmount || '0');
        const amountB = parseFloat(this.parent.tokenBAmount || '0');
        return (amountA === 0 && amountB === 0) || (amountA > 0 && amountB === 0) || (amountA === 0 && amountB > 0);
      }
    ),
    lowerPrice: yup.string().when('isFullRange', {
      is: false,
      then: (schema) =>
        schema
          .required('Lower price is required for concentrated positions')
          .test('is-positive', 'Price must be > 0', (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) > 0)
          .test('is-less-than-upper', 'Lower price must be less than upper price', function (value) {
            const upperPrice = parseFloat(this.parent.upperPrice || '0');
            return parseFloat(value || '0') < upperPrice;
          }),
      otherwise: (schema) => schema.notRequired(),
    }),
    upperPrice: yup.string().when('isFullRange', {
      is: false,
      then: (schema) =>
        schema
          .required('Upper price is required for concentrated positions')
          .test('is-positive', 'Price must be > 0', (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) > 0),
      otherwise: (schema) => schema.notRequired(),
    }),
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
      !form.governedAccount?.extensions.transferAddress || // Owner address
      !wallet?.publicKey || // Funder wallet
      !connection.current
    ) {
      if (!form.governedAccount?.extensions.transferAddress && form.governedAccount) {
        setFormErrors(prev => ({...prev, governedAccount: 'Selected governed account does not have a valid owner address.' }));
      }
      if (!wallet?.connected) {
        setFormErrors(prev => ({...prev, _error: 'Wallet not connected.' }));
      }
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions, prerequisiteInstructionsSigners, additionalSerializedInstructions: [] };
    }

    let tokenMintA: PublicKey | null = null;
    let tokenMintB: PublicKey | null = null;

    try {
      // --- Owner & Funder ---
      const owner = form.governedAccount.extensions.transferAddress;
      const funderWallet = wallet;

      // --- Set Whirlpools Config ---
      await setWhirlpoolsConfig('solanaMainnet');

      // --- Create RPC Client ---
      const rpc = createSolanaRpc(connection.current.rpcEndpoint);

      // --- Prepare Pool Address ---
      const poolAddress = form.poolAddress as Address;
      const poolPublicKey = new PublicKey(form.poolAddress);

      // --- Fetch Pool Account Data and Extract Mints ---
      console.log(`Fetching pool account info for ${poolPublicKey.toBase58()}`);
      const poolAccountInfo = await connection.current.getAccountInfo(poolPublicKey);
      if (!poolAccountInfo) {
        throw new Error(`Pool account not found: ${poolPublicKey.toBase58()}`);
      }
      if (poolAccountInfo.data.length < 173 + 32) {
        throw new Error("Pool account data is too short to contain mints.");
      }
      const mintAOffset = 93;
      const mintBOffset = 173;
      tokenMintA = new PublicKey(poolAccountInfo.data.subarray(mintAOffset, mintAOffset + 32));
      tokenMintB = new PublicKey(poolAccountInfo.data.subarray(mintBOffset, mintBOffset + 32));
      console.log(`Extracted Mints - A: ${tokenMintA.toBase58()}, B: ${tokenMintB.toBase58()}`);

      // --- Prepare SDK Parameters ---
      const param: { tokenA?: bigint; tokenB?: bigint } = {};
      const amountA = parseFloat(form.tokenAAmount || '0');
      const amountB = parseFloat(form.tokenBAmount || '0');

      if (amountA > 0) {
        if (!tokenMintA) throw new Error("Token Mint A not available (logic error).");
        param.tokenA = await uiAmountToBigInt(connection.current, form.tokenAAmount, tokenMintA);
      } else if (amountB > 0) {
        if (!tokenMintB) throw new Error("Token Mint B not available (logic error).");
        param.tokenB = await uiAmountToBigInt(connection.current, form.tokenBAmount, tokenMintB);
      } else {
        throw new Error("Validation Error: At least one token amount must be greater than zero.");
      }

      const lowerPrice = form.isFullRange ? 0 : parseFloat(form.lowerPrice);
      const upperPrice = form.isFullRange ? 0 : parseFloat(form.upperPrice);
      const slippageBps = form.slippageBps;

      // --- Wallet for SDK (Funder) ---
      if (!funderWallet.signTransaction || !funderWallet.publicKey) {
        throw new Error("Connected wallet doesn't have publicKey or signTransaction method.");
      }
      const funderSigner = funderWallet as any; // Cast funder wallet

      // --- Call the Newer SDK function ---
      console.log(`Calling ${form.isFullRange ? 'openFullRangePositionInstructions' : 'openPositionInstructions'}`);
      // ... (rest of the console logs)

      let kitInstructions;
      if (form.isFullRange) {
        // Casting param as any to bypass TS2345
        const { instructions } = await openFullRangePositionInstructions(
          rpc, poolAddress, param as any, slippageBps, funderSigner
        );
        kitInstructions = instructions;
      } else {
        // Casting param as any to bypass TS2345
        const { instructions } = await openPositionInstructions(
          rpc, poolAddress, param as any, lowerPrice, upperPrice, slippageBps, funderSigner
        );
        kitInstructions = instructions;
      }

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
      console.error('Error creating Orca position instruction:', error);
      if (errorMessage.includes("Pool account not found")) {
        setFormErrors({ poolAddress: errorMessage });
      } else if (errorMessage.includes("amount conversion") || errorMessage.includes("Mint account not found")) {
        setFormErrors({ tokenAAmount: errorMessage, tokenBAmount: errorMessage });
      } else if (errorMessage.includes("signTransaction")) {
        setFormErrors({ _error: `Wallet signing function might be incompatible: ${errorMessage}` });
      } else if (errorMessage.includes("serializeInstructionToBase64") || errorMessage.includes("invalid structure")) {
        setFormErrors({ _error: `Failed to serialize instructions - format mismatch likely: ${errorMessage}` });
      } else if (errorMessage.includes("IncreaseLiquidityQuoteParam")) {
        setFormErrors({ _error: `SDK Type Error (Param): ${errorMessage}` }); // More specific error
      }
      else {
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
  // (Inputs remain the same)
  const inputs: InstructionInput[] = [
    {
      label: 'Position Owner (Governance Account)',
      initialValue: form.governedAccount,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts.filter(acc => !!acc.extensions.transferAddress),
    },
    {
      label: 'Whirlpool Address',
      initialValue: form.poolAddress,
      name: 'poolAddress',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Full Range Position?',
      initialValue: form.isFullRange,
      name: 'isFullRange',
      type: InstructionInputType.SWITCH,
    },
    ...(!form.isFullRange
      ? [
        {
          label: 'Lower Price',
          initialValue: form.lowerPrice,
          name: 'lowerPrice',
          type: InstructionInputType.INPUT,
          inputType: 'text',
        },
        {
          label: 'Upper Price',
          initialValue: form.upperPrice,
          name: 'upperPrice',
          type: InstructionInputType.INPUT,
          inputType: 'text',
        },
      ]
      : []),
    {
      label: 'Token A Amount',
      initialValue: form.tokenAAmount,
      name: 'tokenAAmount',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Token B Amount',
      initialValue: form.tokenBAmount,
      name: 'tokenBAmount',
      type: InstructionInputType.INPUT,
      inputType: 'text',
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
  }, [form, governance, index, handleSetInstructions]);

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
