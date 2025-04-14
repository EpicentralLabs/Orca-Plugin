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
  TransactionInstruction,
  Keypair,
  Transaction,
} from '@solana/web3.js';
import { NewProposalContext } from '../../../new';
import InstructionForm, { InstructionInput } from '../FormCreator';
import { InstructionInputType } from '../inputInstructionType';
import { AssetAccount } from '@utils/uiTypes/assets';
import useWalletOnePointOh from '@hooks/useWalletOnePointOh';
import { useRealmQuery } from '@hooks/queries/realm';
import useGovernanceAssets from '@hooks/useGovernanceAssets';
import useLegacyConnectionContext from '@hooks/useLegacyConnectionContext';

// --- Import from Legacy SDK and dependencies ---
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PriceMath,
  TickUtil,
  TokenUtil,
  InitPoolParams,
  WhirlpoolClient,
  buildCreatePoolTransaction, // Use the correct builder
  PDAUtil,
  IGNORE_CACHE,
  TICK_SPACING, // Import predefined tick spacings if needed
} from '@orca-so/whirlpools-sdk';
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js'; // SDK uses decimal.js
import { Percentage } from '@orca-so/common-sdk'; // Although not used directly for pool creation, good to have consistent imports

// --- Define valid Orca Tick Spacings ---
// Reference: https://dev.orca.so/legacy-whirlpools/overview/tick-spacing-and-fees
const VALID_TICK_SPACINGS = [
  TICK_SPACING.STANDARD, // 64 (0.3%)
  TICK_SPACING.STABLE,   // 8 (0.05%) - Might need adjustment based on exact Orca values
  1,  // 1 (0.01%)
  128, // 128 (1.0%)
  // Add others if Orca supports more, check their constants/docs
];

const DEFAULT_TICK_SPACING = TICK_SPACING.STANDARD; // 64

// --- Form State Interface ---
interface CreatePoolForm {
  // governedAccount is not directly used in pool creation IX, funder pays.
  // Keep it for consistency with proposal UI if needed, but it won't be the 'funder' param.
  governedAccount?: AssetAccount;
  tokenAMint: string;
  tokenBMint: string;
  initialPrice: string; // Use string for Decimal precision
  tickSpacing: number; // Required for Whirlpool creation
}

// --- Helper: Convert UI string amount to Decimal ---
const uiAmountToDecimal = (amount: string): Decimal => {
  try {
    // Ensure non-empty string before creating Decimal
    return new Decimal(amount || '0');
  } catch {
    return new Decimal(0);
  }
};

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
  const connection = useLegacyConnectionContext();
  const realm = useRealmQuery().data?.result;
  const { assetAccounts } = useGovernanceAssets(); // Needed for governedAccount selector
  const wallet = useWalletOnePointOh(); // This is the "funder" paying transaction fees

  // --- State ---
  const [form, setForm] = useState<CreatePoolForm>({
    governedAccount: undefined, // Not directly used by IX but needed for UI pattern
    tokenAMint: '',
    tokenBMint: '',
    initialPrice: '0.01', // Default initial price as string
    tickSpacing: DEFAULT_TICK_SPACING, // Default tick spacing
  });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance); // Still relevant for proposal context

  // --- Validation Schema ---
  const schema = yup.object().shape({
    // Keep governedAccount validation if required by the UI pattern
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
      .test(
        'is-positive',
        'Initial price must be positive',
        (val) => {
          try { return new Decimal(val || '0').isPositive(); } catch { return false; }
        }
      ),
    tickSpacing: yup
      .number()
      .required('Tick Spacing is required')
      .oneOf(VALID_TICK_SPACINGS, `Tick spacing must be one of: ${VALID_TICK_SPACINGS.join(', ')}`),
  });

  // --- getInstruction Implementation ---
  async function getInstruction(): Promise<UiInstruction> {
    // Reset errors
    setFormErrors({});

    const isValid = await validateInstruction({ schema, form, setFormErrors });
    const prerequisiteInstructions: TransactionInstruction[] = [];
    const prerequisiteInstructionsSigners: Keypair[] = [];
    const additionalSerializedInstructions: string[] = [];

    // Basic validation and wallet check
    if (
      !isValid ||
      !form.governedAccount?.governance?.account || // Check governed account for proposal context
      !wallet?.publicKey ||
      !connection.current
    ) {
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
        prerequisiteInstructions,
        prerequisiteInstructionsSigners,
        additionalSerializedInstructions,
      };
    }

    try {
      // --- Funder (pays transaction fees) ---
      const funder = wallet.publicKey;

      // --- Initialize Whirlpool SDK Context and Client ---
      const ctx = WhirlpoolContext.withProvider(
        wallet, // Wallet pays fees and signs
        connection.current,
        ORCA_WHIRLPOOL_PROGRAM_ID
      );
      const client = buildWhirlpoolClient(ctx);

      // --- Prepare Mint PublicKeys ---
      const tokenAMintPubKey = new PublicKey(form.tokenAMint);
      const tokenBMintPubKey = new PublicKey(form.tokenBMint);

      // --- Fetch Token Decimals ---
      console.log('Fetching token decimals...');
      const [tokenInfoA, tokenInfoB] = await Promise.all([
        TokenUtil.getTokenInfo(ctx.connection, tokenAMintPubKey),
        TokenUtil.getTokenInfo(ctx.connection, tokenBMintPubKey)
      ]);
      if (!tokenInfoA || !tokenInfoB) {
        throw new Error("Failed to fetch token mint info for one or both tokens.");
      }
      const decimalsA = tokenInfoA.decimals;
      const decimalsB = tokenInfoB.decimals;
      console.log(`Token A Decimals: ${decimalsA}, Token B Decimals: ${decimalsB}`);

      // --- Calculate Initial SqrtPrice ---
      console.log(`Calculating initial sqrtPrice for price: ${form.initialPrice}`);
      const initialPriceDecimal = uiAmountToDecimal(form.initialPrice);
      const initialPriceX64 = PriceMath.decimalToPriceX64(initialPriceDecimal, decimalsA, decimalsB);
      const initialSqrtPriceX64 = PriceMath.priceX64ToSqrtPriceX64(initialPriceX64);
      console.log(`Initial SqrtPriceX64 (BN): ${initialSqrtPriceX64.toString()}`);


      // --- Prepare InitPoolParams ---
      const initPoolParams: InitPoolParams = {
        tokenMintA: tokenAMintPubKey,
        tokenMintB: tokenBMintPubKey,
        tickSpacing: form.tickSpacing,
        initialSqrtPrice: initialSqrtPriceX64,
        funder: funder, // Wallet pays the rent/fees for pool account creation
      };

      console.log('Building create pool transaction...');
      // --- Build the Transaction using the SDK's builder ---
      // This builder calculates the required accounts (pool PDA, fee tier PDA, etc.)
      const createPoolTxBuilder = await buildCreatePoolTransaction(ctx, initPoolParams);

      // --- Get Transaction and Signers ---
      // Pool creation usually doesn't require extra signers beyond the funder (wallet)
      // unless custom accounts are involved, which is not the case here.
      const transaction = await createPoolTxBuilder.build();
      console.log('Transaction built.');

      // --- Serialize Instructions ---
      // The builder includes instructions to create the pool account, fee tier account (if needed), etc.
      transaction.instructions.forEach((ix, idx) => {
        console.log(`Serializing instruction ${idx + 1}/${transaction.instructions.length}`);
        additionalSerializedInstructions.push(serializeInstructionToBase64(ix));
      });

      console.log('Instructions serialized successfully.');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      console.error('Error creating Orca pool instruction:', error);
      setFormErrors({ _error: `Failed to create instruction: ${errorMessage}` });
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
        prerequisiteInstructions,
        prerequisiteInstructionsSigners,
        additionalSerializedInstructions: [], // Clear on error
      };
    }

    // --- Return UiInstruction ---
    return {
      serializedInstruction: '', // Keep empty as per pattern
      isValid: true,
      governance: form.governedAccount?.governance, // Pass governance for proposal context
      prerequisiteInstructions, // Should be empty as builder handles setup
      prerequisiteInstructionsSigners, // Should be empty unless builder returns some
      additionalSerializedInstructions,
      chunkBy: 2, // Pool creation might be 2-3 instructions. Adjust if needed.
    };
  }

  // --- Form Inputs Definition ---
  const inputs: InstructionInput[] = [
    {
      // Keep this input for the proposal pattern, even if not directly used in the IX params
      label: 'Governance Account (For Proposal)',
      tooltip: 'Select the governance account context for this proposal item.',
      initialValue: form.governedAccount,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts,
    },
    {
      label: 'Token A Mint',
      tooltip: 'The mint address of the first token in the pair (e.g., USDC).',
      initialValue: form.tokenAMint,
      name: 'tokenAMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Token B Mint',
      tooltip: 'The mint address of the second token in the pair (e.g., ORCA).',
      initialValue: form.tokenBMint,
      name: 'tokenBMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Initial Price',
      tooltip: 'The starting price of Token A denominated in Token B (e.g., if A=ORCA, B=USDC, price 1.5 means 1 ORCA = 1.5 USDC).',
      initialValue: form.initialPrice,
      name: 'initialPrice',
      type: InstructionInputType.INPUT,
      inputType: 'text', // Use text for Decimal precision
    },
    {
      label: 'Tick Spacing',
      tooltip: `Determines the fee tier and price granularity. Valid options: ${VALID_TICK_SPACINGS.join(', ')}. Lower values for stable pairs, higher for volatile pairs.`,
      initialValue: form.tickSpacing,
      name: 'tickSpacing',
      type: InstructionInputType.SELECT, // Use SELECT for predefined options
      options: VALID_TICK_SPACINGS.map(ts => ({ name: `${ts} (Fee: ${getFeeTierFromTickSpacing(ts)}%)`, value: ts })),
    },
  ];

  // Helper to map tick spacing to fee tier for display
  function getFeeTierFromTickSpacing(tickSpacing: number): string {
    // Reference: https://dev.orca.so/legacy-whirlpools/overview/tick-spacing-and-fees
    switch (tickSpacing) {
      case 1: return "0.01";
      case 8: return "0.05";
      case 64: return "0.30";
      case 128: return "1.00";
      default: return "Unknown";
    }
  }


  // --- useEffect to Register Instruction ---
  useEffect(() => {
    handleSetInstructions(
      {
        governedAccount: form.governedAccount?.governance,
        getInstruction,
      },
      index
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Re-register whenever form state changes
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
