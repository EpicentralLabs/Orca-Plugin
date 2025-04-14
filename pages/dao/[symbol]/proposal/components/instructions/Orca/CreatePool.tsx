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
  createSplashPoolInstructions,
  createConcentratedLiquidityPoolInstructions,
  setWhirlpoolsConfig,
  // Define tick spacing constants if not importing directly
  // TICK_SPACING, // Might not be exported directly
} from '@orca-so/whirlpools';

// --- Import from @solana/kit for RPC and Address ---
import { createSolanaRpc } from '@solana/kit'; // Use kit's RPC creator
import { Address } from '@solana/addresses'; // Newer SDK uses Address type (branded string)

// --- Import supporting types/libs ---
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';

// --- Define valid Orca Tick Spacings (based on legacy constants/docs) ---
// Reference: https://dev.orca.so/legacy-whirlpools/overview/tick-spacing-and-fees
const VALID_TICK_SPACINGS = [
  1,   // 0.01%
  8,   // 0.05%
  64,  // 0.30% (Standard)
  128, // 1.00%
];
const DEFAULT_TICK_SPACING = 64; // Standard

// --- Form State Interface ---
interface CreatePoolForm {
  // governedAccount is for proposal context, not the funder IX param
  governedAccount?: AssetAccount;
  tokenAMint: string;
  tokenBMint: string;
  initialPrice: string; // Use string for Decimal precision in UI
  tickSpacing: number; // Only used if useConcentratedPool is true
  useConcentratedPool: boolean; // Selector between Splash/Concentrated
}

// --- React Component ---
export default function CreatePool({
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
  const [form, setForm] = useState<CreatePoolForm>({
    governedAccount: undefined,
    tokenAMint: '',
    tokenBMint: '',
    initialPrice: '0.01', // Default initial price
    tickSpacing: DEFAULT_TICK_SPACING,
    useConcentratedPool: false, // Default to Splash Pool
  });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance);

  // --- Validation Schema ---
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required('Governance account selection is required for proposal context'),
    tokenAMint: yup
      .string()
      .required('Token A mint is required')
      .test('is-pubkey', 'Invalid Token A Mint address', (value) => {
        try { new PublicKey(value || ''); return true; } catch (e) { return false; }
      }),
    tokenBMint: yup
      .string()
      .required('Token B mint is required')
      .test('is-pubkey', 'Invalid Token B Mint address', (value) => {
        try { new PublicKey(value || ''); return true; } catch (e) { return false; }
      })
      .test('not-same-as-A', 'Token A and Token B mints cannot be the same', function(value) {
        return this.parent.tokenAMint !== value;
      }),
    initialPrice: yup
      .string()
      .required('Initial price is required')
      .test('is-positive', 'Initial price must be positive', (val) => {
        try { return new Decimal(val || '0').isPositive(); } catch { return false; }
      }),
    useConcentratedPool: yup.boolean(),
    tickSpacing: yup.number().when('useConcentratedPool', {
      is: true,
      then: schema => schema
        .required('Tick Spacing is required for Concentrated pools')
        .oneOf(VALID_TICK_SPACINGS, `Tick spacing must be one of: ${VALID_TICK_SPACINGS.join(', ')}`),
      otherwise: schema => schema.notRequired(),
    }),
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
      !form.governedAccount?.governance?.account || // Check governed account for proposal context
      !wallet?.publicKey || // Funder wallet
      !connection.current
    ) {
      // Errors set by validateInstruction or basic checks below
      if (!wallet?.connected) {
        setFormErrors(prev => ({...prev, _error: 'Wallet not connected.' }));
      }
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions, prerequisiteInstructionsSigners, additionalSerializedInstructions: [] };
    }

    try {
      // --- Funder ---
      const funderWallet = wallet; // web3.js wallet adapter

      // --- Set Whirlpools Config ---
      await setWhirlpoolsConfig('solanaMainnet');

      // --- Create RPC Client ---
      const rpc = createSolanaRpc(connection.current.rpcEndpoint);

      // --- Prepare SDK Parameters ---
      const tokenAMintAddress = form.tokenAMint as Address;
      const tokenBMintAddress = form.tokenBMint as Address;
      const initialPriceNumber = parseFloat(form.initialPrice); // SDK expects number
      const tickSpacing = form.tickSpacing; // Already a number

      // --- Wallet for SDK (Funder) ---
      if (!funderWallet.signTransaction || !funderWallet.publicKey) {
        throw new Error("Connected wallet doesn't have publicKey or signTransaction method.");
      }
      const funderSigner = funderWallet as any; // Cast funder wallet

      // --- Call the Newer SDK function based on pool type ---
      console.log(`Calling ${form.useConcentratedPool ? 'createConcentratedLiquidityPoolInstructions' : 'createSplashPoolInstructions'}`);
      console.log(`Mints: A=${tokenAMintAddress}, B=${tokenBMintAddress}`);
      console.log(`Initial Price: ${initialPriceNumber}`);
      if (form.useConcentratedPool) {
        console.log(`Tick Spacing: ${tickSpacing}`);
      }
      console.log(`Funder (passing wallet directly): ${funderWallet?.publicKey?.toBase58()}`);

      let kitInstructions; // Type: Instruction from @solana/transactions
      let poolAddress: Address | undefined = undefined; // SDK returns the potential pool address

      if (form.useConcentratedPool) {
        const result = await createConcentratedLiquidityPoolInstructions(
          rpc,
          tokenAMintAddress,
          tokenBMintAddress,
          tickSpacing,
          initialPriceNumber,
          funderSigner // Pass funder wallet
        );
        kitInstructions = result.instructions;
        poolAddress = result.poolAddress; // Capture pool address
      } else {
        const result = await createSplashPoolInstructions(
          rpc,
          tokenAMintAddress,
          tokenBMintAddress,
          initialPriceNumber,
          funderSigner // Pass funder wallet
        );
        kitInstructions = result.instructions;
        poolAddress = result.poolAddress; // Capture pool address
      }

      console.log(`Received ${kitInstructions.length} instructions from SDK.`);
      console.log(`Predicted Pool Address: ${poolAddress ?? 'N/A'}`);


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
      console.error('Error creating Orca pool instruction:', error);
      if (errorMessage.includes("signTransaction")) {
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
      chunkBy: 2, // Adjust chunk size as needed (pool creation is often 2-3 instructions)
    };
  }

  // Helper to map tick spacing to fee tier for display
  function getFeeTierFromTickSpacing(tickSpacing: number): string {
    switch (tickSpacing) {
      case 1: return "0.01";
      case 8: return "0.05";
      case 64: return "0.30";
      case 128: return "1.00";
      default: return "Unknown";
    }
  }

  // --- Form Inputs Definition ---
  const inputs: InstructionInput[] = [
    {
      label: 'Governance Account (For Proposal)',
      // tooltip: 'Select the governance account context for this proposal item.', // Add back if type allows
      initialValue: form.governedAccount,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts, // Use all asset accounts for context? Or filter?
    },
    {
      label: 'Token A Mint',
      // tooltip: 'The mint address of the first token in the pair (e.g., USDC).', // Add back if type allows
      initialValue: form.tokenAMint,
      name: 'tokenAMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Token B Mint',
      // tooltip: 'The mint address of the second token in the pair (e.g., ORCA).', // Add back if type allows
      initialValue: form.tokenBMint,
      name: 'tokenBMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Initial Price',
      // tooltip: 'The starting price of Token A denominated in Token B.', // Add back if type allows
      initialValue: form.initialPrice,
      name: 'initialPrice',
      type: InstructionInputType.INPUT,
      inputType: 'text', // Use text for Decimal precision
    },
    {
      label: 'Use Concentrated Pool?',
      // tooltip: 'Check this to create a Concentrated Liquidity pool (requires Tick Spacing). If unchecked, a simpler Splash pool is created.', // Add back if type allows
      initialValue: form.useConcentratedPool,
      name: 'useConcentratedPool',
      type: InstructionInputType.SWITCH,
    },
    // Conditionally show Tick Spacing only for Concentrated pools
    ...(form.useConcentratedPool
      ? [
        {
          label: 'Tick Spacing',
          // tooltip: `Determines the fee tier and price granularity. Lower values for stable pairs, higher for volatile pairs.`, // Add back if type allows
          initialValue: form.tickSpacing,
          name: 'tickSpacing',
          type: InstructionInputType.SELECT, // Use SELECT for predefined options
          options: VALID_TICK_SPACINGS.map(ts => ({ name: `${ts} (Fee: ${getFeeTierFromTickSpacing(ts)}%)`, value: ts })),
        },
      ]
      : []),
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
