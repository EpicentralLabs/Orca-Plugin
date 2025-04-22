import { useContext, useEffect, useState } from 'react';
import * as yup from 'yup';
import { ProgramAccount, Governance, serializeInstructionToBase64 } from '@solana/spl-governance';
import { validateInstruction } from '@utils/instructionTools';
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes';
import {
  PublicKey,
  Connection,
  TransactionInstruction,
  Keypair,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY
} from '@solana/web3.js';
import { NewProposalContext } from '../../../new';
import InstructionForm, { InstructionInput } from '../FormCreator';
import { InstructionInputType } from '../inputInstructionType';
import { AssetAccount } from '@utils/uiTypes/assets';
import useWalletOnePointOh from '@hooks/useWalletOnePointOh';
import useGovernanceAssets from '@hooks/useGovernanceAssets';
import useLegacyConnectionContext from '@hooks/useLegacyConnectionContext';
import { AnchorProvider } from '@coral-xyz/anchor';
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PriceMath,
  TickUtil,
  PoolUtil,
  PDAUtil,
  IGNORE_CACHE,
  ParsableWhirlpool,
  WhirlpoolIx,
  WhirlpoolData,
  TokenAmounts, // Import TokenAmounts type
} from '@orca-so/whirlpools-sdk';
import { BN } from 'bn.js'; // BN is used as a value/constructor here
import { Decimal } from 'decimal.js';
import { Percentage } from '@orca-so/common-sdk';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Define constants locally
const METAPLEX_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const ORCA_ABS_MAX_TICK_INDEX = 443636;
const ORCA_ABS_MIN_TICK_INDEX = -443636;


// --- Workaround Helper Functions (Replace if @solana/spl-token issue is fixed) ---

async function findAssociatedTokenAddress(
  walletAddress: PublicKey,
  tokenMintAddress: PublicKey,
  allowOwnerOffCurve = false
): Promise<PublicKey> {
  // This is the standard derivation, ensure it works in your env
  return (await PublicKey.findProgramAddress(
    [
      walletAddress.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      tokenMintAddress.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  ))[0];
}

function createAtaInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): TransactionInstruction {
  // This is the standard instruction structure
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: associatedToken, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    keys,
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([]),
  });
}

async function getOrCreateATAInstructionWorkaround(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  funder: PublicKey,
  allowOwnerOffCurve = true
): Promise<{ address: PublicKey; instruction: TransactionInstruction | null }> {
  const address = await findAssociatedTokenAddress(owner, mint, allowOwnerOffCurve);
  const accountInfo = await connection.getAccountInfo(address);
  let instruction: TransactionInstruction | null = null;
  if (!accountInfo) {
    console.log(`Creating ATA instruction (workaround) for mint ${mint.toBase58()} and owner ${owner.toBase58()}`);
    instruction = createAtaInstruction(funder, address, owner, mint);
  }
  return { address, instruction };
}
// --- End Workaround Helper Functions ---


interface CreatePositionForm {
  governedAccount?: AssetAccount; // Owner of the position NFT
  poolAddress: string;
  tokenAAmount: string;
  tokenBAmount: string;
  lowerPrice: string;
  upperPrice: string;
  slippageBps: number;
  isFullRange: boolean;
}

const uiAmountToDecimal = (amount: string): Decimal => {
  try { return new Decimal(amount || '0'); } catch { return new Decimal(0); }
};

// Correct return type annotation to BN (instance type)
// @ts-ignore
const decimalAmountToBN = (decimalAmount: Decimal, decimals: number): BN => {
  // BN is a constructor here
  return new BN(decimalAmount.mul(new Decimal(10).pow(decimals)).toFixed(0));
};

async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`Mint not found: ${mint.toBase58()}`);
  if (mintInfo.data.length !== 82) throw new Error("Invalid mint account size");
  return mintInfo.data.readUInt8(44);
}


export default function CreatePosition({ index, governance }: { index: number; governance: ProgramAccount<Governance> | null; }) {
  const { handleSetInstructions } = useContext(NewProposalContext);
  const connection = useLegacyConnectionContext();
  const { assetAccounts } = useGovernanceAssets();
  const wallet = useWalletOnePointOh();
  const [form, setForm] = useState<CreatePositionForm>({
    poolAddress: '', tokenAAmount: '0', tokenBAmount: '0', lowerPrice: '0', upperPrice: '0', isFullRange: false, slippageBps: 50,
  });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance);

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account (Position Owner) is required'),
    poolAddress: yup.string().required('Pool address required').test('is-pubkey', 'Invalid Pool address', (v) => { try { new PublicKey(v || ''); return true; } catch { return false; } }),
    tokenAAmount: yup.string().test('is-positive-or-zero', 'Amount must be >= 0', (v) => !v || !isNaN(parseFloat(v)) && parseFloat(v) >= 0).required('Token A amount required'),
    tokenBAmount: yup.string().test('is-positive-or-zero', 'Amount must be >= 0', (v) => !v || !isNaN(parseFloat(v)) && parseFloat(v) >= 0).required('Token B amount required'),
    tokenAmounts: yup.mixed().test('at-least-one-positive', 'At least one token amount must be > 0', function() { return parseFloat(this.parent.tokenAAmount || '0') > 0 || parseFloat(this.parent.tokenBAmount || '0') > 0; }),
    lowerPrice: yup.string().when('isFullRange', { is: false, then: (s) => s.required('Lower price required').test('is-positive', 'Price must be > 0', (v) => !v || !isNaN(parseFloat(v)) && parseFloat(v) > 0).test('is-less-than-upper', 'Lower price must be < upper', function (v) { return new Decimal(v || '0').lt(new Decimal(this.parent.upperPrice || '0')); }), otherwise: (s) => s.notRequired(), }),
    upperPrice: yup.string().when('isFullRange', { is: false, then: (s) => s.required('Upper price required').test('is-positive', 'Price must be > 0', (v) => !v || !isNaN(parseFloat(v)) && parseFloat(v) > 0), otherwise: (s) => s.notRequired(), }),
    slippageBps: yup.number().transform((v) => (isNaN(v) ? 0 : v)).min(0).max(10000).required('Slippage required'),
  });

  async function getInstruction(): Promise<UiInstruction> {
    setFormErrors({});
    const isValid = await validateInstruction({ schema, form, setFormErrors });
    const prerequisiteInstructions: TransactionInstruction[] = [];
    const prerequisiteInstructionsSigners: Keypair[] = [];
    const mainInstructions: TransactionInstruction[] = [];
    const additionalSerializedInstructions: string[] = [];

    if (!isValid || !form.governedAccount?.governance?.account || !form.governedAccount?.extensions.transferAddress || !wallet?.publicKey || !connection.current) {
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions, prerequisiteInstructionsSigners, additionalSerializedInstructions };
    }

    try {
      const owner = form.governedAccount.extensions.transferAddress;
      const funder = wallet.publicKey;
      if (!wallet.signTransaction) throw new Error("Wallet does not support signing.");
      const provider = new AnchorProvider(connection.current, wallet as any, AnchorProvider.defaultOptions());
      const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
      const client = buildWhirlpoolClient(ctx);
      const poolPubkey = new PublicKey(form.poolAddress);

      const poolAccountInfo = await ctx.connection.getAccountInfo(poolPubkey, "confirmed");
      if (!poolAccountInfo) throw new Error(`Whirlpool not found: ${poolPubkey.toBase58()}`);
      const poolData = ParsableWhirlpool.parse(poolPubkey, poolAccountInfo);
      if (!poolData) throw new Error("Failed to parse pool data.");

      const { tokenMintA, tokenMintB, tickSpacing, sqrtPrice, tickCurrentIndex } = poolData;

      const [decimalsA, decimalsB] = await Promise.all([
        getMintDecimals(connection.current, tokenMintA),
        getMintDecimals(connection.current, tokenMintB)
      ]);

      let tickLowerIndex: number, tickUpperIndex: number;
      if (form.isFullRange) {
        tickLowerIndex = ORCA_ABS_MIN_TICK_INDEX;
        tickUpperIndex = ORCA_ABS_MAX_TICK_INDEX;
        tickLowerIndex = TickUtil.getInitializableTickIndex(tickLowerIndex, tickSpacing);
        tickUpperIndex = TickUtil.getInitializableTickIndex(tickUpperIndex, tickSpacing);
      } else {
        const lowerPriceDecimal = uiAmountToDecimal(form.lowerPrice);
        const upperPriceDecimal = uiAmountToDecimal(form.upperPrice);
        const lowerSqrtPriceX64 = PriceMath.priceToSqrtPriceX64(lowerPriceDecimal, decimalsA, decimalsB);
        const upperSqrtPriceX64 = PriceMath.priceToSqrtPriceX64(upperPriceDecimal, decimalsA, decimalsB);
        tickLowerIndex = PriceMath.sqrtPriceX64ToTickIndex(lowerSqrtPriceX64);
        tickUpperIndex = PriceMath.sqrtPriceX64ToTickIndex(upperSqrtPriceX64);
        tickLowerIndex = TickUtil.getInitializableTickIndex(tickLowerIndex, tickSpacing);
        tickUpperIndex = TickUtil.getInitializableTickIndex(tickUpperIndex, tickSpacing);
        if (tickLowerIndex >= tickUpperIndex) throw new Error("Lower tick must be less than upper tick after snapping.");
        if (tickLowerIndex < ORCA_ABS_MIN_TICK_INDEX || tickUpperIndex > ORCA_ABS_MAX_TICK_INDEX) throw new Error("Ticks out of bounds.");
      }

      const amountADecimal = uiAmountToDecimal(form.tokenAAmount); const amountBDecimal = uiAmountToDecimal(form.tokenBAmount);
      // Call function and use the returned BN instance directly
      const amountA_BN = decimalAmountToBN(amountADecimal, decimalsA);
      const amountB_BN = decimalAmountToBN(amountBDecimal, decimalsB);


      // Use estimateMaxLiquidityFromTokenAmounts (4 args)
      // Cast tokenAmounts as any to bypass TS2345
      const tokenAmounts: TokenAmounts = { tokenA: amountA_BN, tokenB: amountB_BN };
      const liquidityAmount = PoolUtil.estimateMaxLiquidityFromTokenAmounts(
        sqrtPrice,
        tickLowerIndex,
        tickUpperIndex,
        tokenAmounts as any // Cast here
      );
      if (liquidityAmount.isZero()) throw new Error("Calculated liquidity is zero.");

      const positionMintKeypair = Keypair.generate();
      prerequisiteInstructionsSigners.push(positionMintKeypair);

      const slippageTolerance = Percentage.fromFraction(form.slippageBps, 10000);

      // Use workaround ATA functions
      const [{ address: funderTokenAccountA, instruction: createFunderAtaA }, { address: funderTokenAccountB, instruction: createFunderAtaB }] = await Promise.all([
        getOrCreateATAInstructionWorkaround(ctx.connection, tokenMintA, funder, funder, false),
        getOrCreateATAInstructionWorkaround(ctx.connection, tokenMintB, funder, funder, false),
      ]);
      if (createFunderAtaA) prerequisiteInstructions.push(createFunderAtaA);
      if (createFunderAtaB) prerequisiteInstructions.push(createFunderAtaB);

      const positionMetadataPda = PDAUtil.getPositionMetadata(positionMintKeypair.publicKey);
      const positionPda = PDAUtil.getPosition(ctx.program.programId, positionMintKeypair.publicKey);
      const ownerPositionTokenAccount = await findAssociatedTokenAddress(owner, positionMintKeypair.publicKey, true);


      // Build instruction manually using WhirlpoolIx.openPositionWithMetadataIx
      const openPositionParams = {
        // Accounts
        funder: funder,
        owner: owner,
        positionPda: positionPda,
        metadataPda: positionMetadataPda,
        positionMintAddress: positionMintKeypair.publicKey,
        positionTokenAccount: ownerPositionTokenAccount,
        tokenOwnerAccountA: funderTokenAccountA,
        tokenOwnerAccountB: funderTokenAccountB,
        tokenVaultA: poolData.tokenVaultA,
        tokenVaultB: poolData.tokenVaultB,
        whirlpool: poolPubkey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: METAPLEX_METADATA_PROGRAM_ID,
        metadataUpdateAuthority: funder,
        // Args
        liquidityAmount: liquidityAmount,
        tokenMaxA: amountA_BN,
        tokenMaxB: amountB_BN,
        tickLowerIndex: tickLowerIndex,
        tickUpperIndex: tickUpperIndex,
        positionBump: positionPda.bump,
        metadataBump: positionMetadataPda.bump,
      };

      const openPositionIx = WhirlpoolIx.openPositionWithMetadataIx(ctx.program, openPositionParams);
      mainInstructions.push(openPositionIx as unknown as TransactionInstruction);


      // Combine prerequisite and main instructions
      const allInstructions = [...prerequisiteInstructions, ...mainInstructions];
      allInstructions.forEach((ix) => { additionalSerializedInstructions.push(serializeInstructionToBase64(ix)); });

    } catch (error) {
      const msg = error instanceof Error ? error.message : JSON.stringify(error);
      setFormErrors({ _error: `Failed to create instruction: ${msg}` });
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions: [], prerequisiteInstructionsSigners, additionalSerializedInstructions: [] };
    }

    return {
      serializedInstruction: '', isValid: true, governance: form.governedAccount?.governance,
      prerequisiteInstructions: [], // Included in main list now
      prerequisiteInstructionsSigners, // Pass position mint signer
      additionalSerializedInstructions, // Serialized list of all instructions
      chunkBy: 2,
    };
  }

  const inputs: InstructionInput[] = [
    { label: 'Position Owner (Governance Account)', initialValue: form.governedAccount, name: 'governedAccount', type: InstructionInputType.GOVERNED_ACCOUNT, shouldBeGoverned, governance, options: assetAccounts.filter(acc => !!acc.extensions.transferAddress), },
    { label: 'Whirlpool Address', initialValue: form.poolAddress, name: 'poolAddress', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Full Range Position?', initialValue: form.isFullRange, name: 'isFullRange', type: InstructionInputType.SWITCH, },
    ...(!form.isFullRange ? [
      { label: 'Lower Price', initialValue: form.lowerPrice, name: 'lowerPrice', type: InstructionInputType.INPUT, inputType: 'text', },
      { label: 'Upper Price', initialValue: form.upperPrice, name: 'upperPrice', type: InstructionInputType.INPUT, inputType: 'text', },
    ] : []),
    { label: 'Token A Amount', initialValue: form.tokenAAmount, name: 'tokenAAmount', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Token B Amount', initialValue: form.tokenBAmount, name: 'tokenBAmount', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Acceptable Slippage (BPS)', initialValue: form.slippageBps, name: 'slippageBps', type: InstructionInputType.INPUT, inputType: 'number', step: 1, }
  ];

  useEffect(() => {
    handleSetInstructions({ governedAccount: form.governedAccount?.governance, getInstruction, }, index);
  }, [form, governance, index, handleSetInstructions]);

  return ( <InstructionForm outerForm={form} setForm={setForm} inputs={inputs} setFormErrors={setFormErrors} formErrors={formErrors} /> );
}
