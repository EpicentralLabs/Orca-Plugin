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
  PoolUtil,
  WhirlpoolData,
  TokenUtil,
  InitPoolParams, // Although not creating pool, might need types
  OpenPositionParams,
  OpenPositionWithMetadataParams,
  WhirlpoolClient,
  buildOpenPositionTransaction,
  PDAUtil,
  IGNORE_CACHE,
} from '@orca-so/whirlpools-sdk';
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js'; // SDK uses decimal.js
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token'; // Use functions from spl-token
import { Percentage } from '@orca-so/common-sdk'; // Import Percentage

// --- Form State Interface ---
interface CreatePositionForm {
  governedAccount?: AssetAccount; // The owner of the position NFT (likely a DAO treasury ATA or SOL account)
  poolAddress: string;
  tokenAAmount: string; // Use string for UI input, convert to Decimal/BN
  tokenBAmount: string; // Use string for UI input, convert to Decimal/BN
  lowerPrice: string; // Use string for UI input, convert to Decimal
  upperPrice: string; // Use string for UI input, convert to Decimal
  slippageBps: number; // Basis points (e.g., 100 for 1%)
  isFullRange: boolean;
}

// --- Helper: Convert UI string amount to Decimal ---
const uiAmountToDecimal = (amount: string): Decimal => {
  try {
    return new Decimal(amount);
  } catch {
    return new Decimal(0);
  }
};

// --- Helper: Convert Decimal amount to BN based on mint decimals ---
const decimalAmountToBN = (
  decimalAmount: Decimal,
  decimals: number
): BN => {
  return new BN(decimalAmount.mul(new Decimal(10).pow(decimals)).toFixed(0));
};

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
  const connection = useLegacyConnectionContext();
  const realm = useRealmQuery().data?.result;
  const { assetAccounts } = useGovernanceAssets();
  const wallet = useWalletOnePointOh(); // This is the "funder" paying transaction fees

  // --- State ---
  const [form, setForm] = useState<CreatePositionForm>({
    poolAddress: '',
    tokenAAmount: '0',
    tokenBAmount: '0',
    lowerPrice: '0',
    upperPrice: '0',
    isFullRange: false,
    slippageBps: 50, // Default 0.5% slippage
  });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance);

  // --- Validation Schema ---
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required('Governed account (Position Owner) is required'),
    poolAddress: yup
      .string()
      .required('Pool address is required')
      .test('is-pubkey', 'Invalid Pool address', (value) => {
        try {
          new PublicKey(value || '');
          return true;
        } catch (e) {
          return false;
        }
      }),
    tokenAAmount: yup
      .string()
      .test(
        'is-positive-or-zero',
        'Amount must be positive or zero',
        (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) >= 0
      )
      .required('Token A amount is required'),
    tokenBAmount: yup
      .string()
      .test(
        'is-positive-or-zero',
        'Amount must be positive or zero',
        (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) >= 0
      )
      .required('Token B amount is required'),
    // Require at least one amount to be positive
    tokenAmounts: yup.mixed().test(
      'at-least-one-positive',
      'At least one token amount must be greater than zero',
      function() {
        const amountA = parseFloat(this.parent.tokenAAmount || '0');
        const amountB = parseFloat(this.parent.tokenBAmount || '0');
        return amountA > 0 || amountB > 0;
      }
    ),
    lowerPrice: yup.string().when('isFullRange', {
      is: false,
      then: (schema) =>
        schema
          .required('Lower price is required for concentrated positions')
          .test(
            'is-positive',
            'Price must be positive',
            (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) > 0
          )
          .test(
            'is-less-than-upper',
            'Lower price must be less than upper price',
            function (value) {
              const upperPrice = new Decimal(this.parent.upperPrice || '0');
              const lowerPrice = new Decimal(value || '0');
              return lowerPrice.lt(upperPrice);
            }
          ),
      otherwise: (schema) => schema.notRequired(),
    }),
    upperPrice: yup.string().when('isFullRange', {
      is: false,
      then: (schema) =>
        schema
          .required('Upper price is required for concentrated positions')
          .test(
            'is-positive',
            'Price must be positive',
            (val) => !val || !isNaN(parseFloat(val)) && parseFloat(val) > 0
          ),
      otherwise: (schema) => schema.notRequired(),
    }),
    slippageBps: yup
      .number()
      .transform((value) => (isNaN(value) ? 0 : value)) // Handle NaN input
      .min(0, 'Slippage cannot be negative')
      .max(10000, 'Slippage cannot exceed 10000 BPS (100%)')
      .required('Slippage is required'),
  });

  // --- getInstruction Implementation ---
  async function getInstruction(): Promise<UiInstruction> {
    // Reset errors on each attempt
    setFormErrors({});

    const isValid = await validateInstruction({ schema, form, setFormErrors });
    const prerequisiteInstructions: TransactionInstruction[] = [];
    const prerequisiteInstructionsSigners: Keypair[] = [];
    const additionalSerializedInstructions: string[] = [];

    // Basic validation and wallet check
    if (
      !isValid ||
      !form.governedAccount?.governance?.account ||
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
      // --- Determine Owner and Funder ---
      // The DAO treasury/account that will own the Position NFT
      const owner = form.governedAccount.extensions.transferAddress!; // Use governance address (needs ATAs derived from this)
      // The user's connected wallet paying for the transaction
      const funder = wallet.publicKey;

      // --- Initialize Whirlpool SDK Context and Client ---
      const ctx = WhirlpoolContext.withProvider(
        wallet, // Wallet must implement Signer & Provider interfaces from @project-serum/anchor
        connection.current,
        ORCA_WHIRLPOOL_PROGRAM_ID
      );
      const client = buildWhirlpoolClient(ctx);
      const poolPubkey = new PublicKey(form.poolAddress);

      // --- Fetch Pool Data ---
      console.log(`Fetching pool data for ${poolPubkey.toBase58()}...`);
      const poolData = await client.getPool(poolPubkey, IGNORE_CACHE); // Use IGNORE_CACHE for latest state
      if (!poolData) {
        throw new Error(`Whirlpool not found: ${poolPubkey.toBase58()}`);
      }
      console.log('Pool data fetched:', poolData);

      const { tokenMintA, tokenMintB, tickSpacing, sqrtPriceX64, tickCurrentIndex } = poolData;

      // --- Fetch Token Decimals ---
      console.log('Fetching token decimals...');
      const [tokenInfoA, tokenInfoB] = await Promise.all([
        TokenUtil.getTokenInfo(ctx.connection, tokenMintA),
        TokenUtil.getTokenInfo(ctx.connection, tokenMintB)
      ]);
      if (!tokenInfoA || !tokenInfoB) {
        throw new Error("Failed to fetch token mint info");
      }
      const decimalsA = tokenInfoA.decimals;
      const decimalsB = tokenInfoB.decimals;
      console.log(`Token A Decimals: ${decimalsA}, Token B Decimals: ${decimalsB}`);

      // --- Determine Tick Indexes ---
      let tickLowerIndex: number;
      let tickUpperIndex: number;

      if (form.isFullRange) {
        tickLowerIndex = TickUtil.getMinTickIndex(tickSpacing);
        tickUpperIndex = TickUtil.getMaxTickIndex(tickSpacing);
        console.log(`Full range selected. Tick Lower: ${tickLowerIndex}, Tick Upper: ${tickUpperIndex}`);
      } else {
        // Convert UI prices (strings) to Decimal objects
        const lowerPriceDecimal = uiAmountToDecimal(form.lowerPrice);
        const upperPriceDecimal = uiAmountToDecimal(form.upperPrice);

        console.log(`Calculating ticks for price range: ${lowerPriceDecimal.toString()} - ${upperPriceDecimal.toString()}`);

        // Convert Decimal prices to PriceX64 (BN)
        const lowerPriceX64 = PriceMath.decimalToPriceX64(lowerPriceDecimal, decimalsA, decimalsB);
        const upperPriceX64 = PriceMath.decimalToPriceX64(upperPriceDecimal, decimalsA, decimalsB);

        // Convert PriceX64 to Tick Index
        tickLowerIndex = PriceMath.priceX64ToTickIndex(lowerPriceX64);
        tickUpperIndex = PriceMath.priceX64ToTickIndex(upperPriceX64);

        // Snap ticks to the nearest initializable tick index based on tickSpacing
        tickLowerIndex = TickUtil.getInitializableTickIndex(tickLowerIndex, tickSpacing);
        tickUpperIndex = TickUtil.getInitializableTickIndex(tickUpperIndex, tickSpacing);

        console.log(`Calculated initializable ticks. Lower: ${tickLowerIndex}, Upper: ${tickUpperIndex}`);

        // Final validation after snapping
        if (tickLowerIndex >= tickUpperIndex) {
          throw new Error("Lower tick must be less than upper tick after snapping to initializable indices.");
        }
        if (tickLowerIndex < TickUtil.getMinTickIndex(tickSpacing) || tickUpperIndex > TickUtil.getMaxTickIndex(tickSpacing)) {
          throw new Error("Calculated ticks are out of allowable bounds for this pool's tick spacing.");
        }
      }

      // --- Calculate Liquidity Amount from Token Inputs ---
      console.log('Calculating liquidity amount...');
      const amountADecimal = uiAmountToDecimal(form.tokenAAmount);
      const amountBDecimal = uiAmountToDecimal(form.tokenBAmount);

      const amountA_BN = decimalAmountToBN(amountADecimal, decimalsA);
      const amountB_BN = decimalAmountToBN(amountBDecimal, decimalsB);

      // Use PoolUtil to estimate liquidity. It requires the pool's current sqrtPrice.
      // This function determines liquidity based on the provided token amounts and the price range.
      const liquidityAmount = PoolUtil.estimateLiquidityFromTokenAmounts(
        tickCurrentIndex,
        tickLowerIndex,
        tickUpperIndex,
        { tokenA: amountA_BN, tokenB: amountB_BN },
        true, // Adjust for slippage here? SDK might handle it later. Let's assume true for now.
        poolData // Pass the fetched pool data
      );

      console.log(`Calculated liquidity amount (BN): ${liquidityAmount.toString()}`);

      if (liquidityAmount.isZero()) {
        throw new Error("Calculated liquidity is zero. Check token amounts and price range relative to the current pool price.");
      }

      // --- Generate Position NFT Mint Keypair ---
      const positionMintKeypair = Keypair.generate();
      console.log(`Generated Position NFT Mint Keypair: ${positionMintKeypair.publicKey.toBase58()}`);
      // This keypair needs to sign the transaction to create the mint account.
      prerequisiteInstructionsSigners.push(positionMintKeypair);

      // --- Prepare parameters for buildOpenPositionTransaction ---
      const slippageTolerance = Percentage.fromFraction(form.slippageBps, 10000); // Convert BPS to Percentage (e.g., 100 BPS = 100/10000 = 0.01 or 1%)
      console.log(`Slippage tolerance: ${slippageTolerance.toString()}`);

      const openPositionParams: OpenPositionWithMetadataParams = {
        poolAddress: poolPubkey,
        owner: owner, // The DAO treasury address
        funder: funder, // The user's wallet paying tx fees
        positionMint: positionMintKeypair.publicKey, // The new mint address
        tickLowerIndex: tickLowerIndex,
        tickUpperIndex: tickUpperIndex,
        liquidityAmount: liquidityAmount,
        // Source ATAs will be derived by the SDK or need to be provided if not standard derivation
        // The SDK's TransactionBuilder usually handles finding/creating ATAs for the 'owner'
        slippage: slippageTolerance,
      };

      console.log('Building open position transaction...');
      // --- Build the Transaction using the SDK's builder ---
      const openPositionTxBuilder = await buildOpenPositionTransaction(ctx, openPositionParams);

      // --- Get Transaction and Signers ---
      const transaction = await openPositionTxBuilder.build();
      console.log('Transaction built.');

      // Add any additional signers returned by the builder (potentially metadata signers, etc.)
      // The positionMintKeypair is already added manually above.
      transaction.signers?.forEach(signer => {
        // Avoid adding duplicates if the builder includes the mint keypair
        if (!prerequisiteInstructionsSigners.some(s => s.publicKey.equals(signer.publicKey))) {
          prerequisiteInstructionsSigners.push(signer);
        }
      });
      console.log(`Total signers required: ${prerequisiteInstructionsSigners.length}`);

      // --- Serialize Instructions ---
      // The TransactionBuilder might include setup instructions (like ATA creation)
      // We should serialize all instructions from the final built transaction payload.
      transaction.instructions.forEach((ix, idx) => {
        console.log(`Serializing instruction ${idx + 1}/${transaction.instructions.length}`);
        additionalSerializedInstructions.push(serializeInstructionToBase64(ix));
      });

      console.log('Instructions serialized successfully.');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      console.error('Error creating Orca position instruction:', error);
      setFormErrors({ _error: `Failed to create instruction: ${errorMessage}` });
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
        prerequisiteInstructions, // May be empty if builder handles everything
        prerequisiteInstructionsSigners,
        additionalSerializedInstructions: [], // Clear on error
      };
    }

    // --- Return UiInstruction ---
    return {
      serializedInstruction: '', // Keep empty as per PlaceLimitOrder example pattern
      isValid: true,
      governance: form.governedAccount?.governance,
      prerequisiteInstructions, // Usually empty as builder includes setup
      prerequisiteInstructionsSigners,
      additionalSerializedInstructions,
      chunkBy: 2, // Orca open position can sometimes involve ~4 instructions, chunking might be safe. Adjust as needed.
    };
  }

  // --- Form Inputs Definition ---
  const inputs: InstructionInput[] = [
    {
      label: 'Position Owner (Governance Account)',
      tooltip: 'The DAO account that will own the Position NFT representing the liquidity.',
      initialValue: form.governedAccount,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts.filter(acc => !!acc.extensions.transferAddress), // Filter for accounts that can own NFTs/Tokens
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
      tooltip: 'Provide liquidity across the entire price range (like a standard Uniswap V2 pool). Ignores Lower/Upper Price.',
      initialValue: form.isFullRange,
      name: 'isFullRange',
      type: InstructionInputType.SWITCH,
    },
    // Conditionally show price inputs only if not full range
    ...(!form.isFullRange
      ? [
        {
          label: 'Lower Price',
          tooltip: 'The minimum price for your concentrated liquidity range.',
          initialValue: form.lowerPrice,
          name: 'lowerPrice',
          type: InstructionInputType.INPUT,
          inputType: 'text', // Use text for Decimal precision
        },
        {
          label: 'Upper Price',
          tooltip: 'The maximum price for your concentrated liquidity range.',
          initialValue: form.upperPrice,
          name: 'upperPrice',
          type: InstructionInputType.INPUT,
          inputType: 'text', // Use text for Decimal precision
        },
      ]
      : []),
    {
      label: 'Token A Amount',
      tooltip: 'Amount of the first token in the pool pair to deposit.',
      initialValue: form.tokenAAmount,
      name: 'tokenAAmount',
      type: InstructionInputType.INPUT,
      inputType: 'text', // Use text for Decimal/BN precision
    },
    {
      label: 'Token B Amount',
      tooltip: 'Amount of the second token in the pool pair to deposit.',
      initialValue: form.tokenBAmount,
      name: 'tokenBAmount',
      type: InstructionInputType.INPUT,
      inputType: 'text', // Use text for Decimal/BN precision
    },
    {
      label: 'Acceptable Slippage (BPS)',
      tooltip: 'Maximum allowed price change during transaction execution, in Basis Points (100 BPS = 1%).',
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Re-register whenever form state changes
  }, [form, governance, index, handleSetInstructions]); // Include governance, index, handleSetInstructions

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
