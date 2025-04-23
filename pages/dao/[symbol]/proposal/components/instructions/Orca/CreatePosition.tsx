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
import { AnchorProvider, Program } from '@coral-xyz/anchor'; // Use Program
import {
  WhirlpoolContext,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PriceMath,
  TickUtil,
  PoolUtil,
  PDAUtil,
  IGNORE_CACHE, // Keep for direct fetches if needed
  WhirlpoolIx,
  TokenAmounts,
} from '@orca-so/whirlpools-sdk';
import { IDL as WhirlpoolIDL } from '@orca-so/whirlpools-sdk/dist/artifacts/whirlpool'; // Import IDL
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';
import { Percentage } from '@orca-so/common-sdk';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Define constants locally
const METAPLEX_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const ORCA_ABS_MAX_TICK_INDEX = 443636;
const ORCA_ABS_MIN_TICK_INDEX = -443636;


// --- Workaround Helper Functions ---

async function findAssociatedTokenAddress(
  walletAddress: PublicKey,
  tokenMintAddress: PublicKey,
  allowOwnerOffCurve = false
): Promise<PublicKey> {
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
    instruction = createAtaInstruction(funder, address, owner, mint);
  }
  return { address, instruction };
}

async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  console.log(`getMintDecimals: Fetching info for mint: ${mint?.toBase58()}`); // Added Log
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`Mint not found: ${mint.toBase58()}`);
  if (mintInfo.data.length !== 82) throw new Error(`Invalid mint account size for ${mint.toBase58()}: ${mintInfo.data.length}`);
  const decimals = mintInfo.data.readUInt8(44);
  console.log(`getMintDecimals: Decimals for ${mint.toBase58()} are ${decimals}`); // Added Log
  return decimals;
}

const uiAmountToDecimal = (amount: string): Decimal => {
  try { return new Decimal(amount || '0'); } catch { return new Decimal(0); }
};

const decimalAmountToBN = (decimalAmount: Decimal, decimals: number): BN => {
  return new BN(decimalAmount.mul(new Decimal(10).pow(decimals)).toFixed(0));
};

// Helper to parse public key from buffer
function parsePublicKey(buffer: Buffer, offset: number): PublicKey {
  if (buffer.length < offset + 32) throw new Error(`Buffer too short to parse PublicKey at offset ${offset}`);
  return new PublicKey(buffer.slice(offset, offset + 32));
}
// Helper to parse BN from buffer (16 bytes / 128 bits)
function parseBN128(buffer: Buffer, offset: number): BN {
  if (buffer.length < offset + 16) throw new Error(`Buffer too short to parse BN128 at offset ${offset}`);
  return new BN(buffer.slice(offset, offset + 16), 10, "le");
}
// Helper to parse i32 from buffer
function parseInt32(buffer: Buffer, offset: number): number {
  if (buffer.length < offset + 4) throw new Error(`Buffer too short to parse Int32 at offset ${offset}`);
  return buffer.readInt32LE(offset);
}
// Helper to parse u16 from buffer
function parseUInt16(buffer: Buffer, offset: number): number {
  if (buffer.length < offset + 2) throw new Error(`Buffer too short to parse UInt16 at offset ${offset}`);
  return buffer.readUInt16LE(offset);
}
// --- End Helper Functions ---


interface CreatePositionForm {
  governedAccount?: AssetAccount; // Owner of the position NFT
  poolAddress: string;
  tokenAAmount: string; // Input amount for ONE token
  tokenBAmount: string; // Input amount for ONE token
  lowerPrice: string;
  upperPrice: string;
  slippageBps: number;
  isFullRange: boolean;
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

  // Updated schema: require exactly one token amount > 0
  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account (Position Owner) is required'),
    poolAddress: yup.string().required('Pool address required').test('is-pubkey', 'Invalid Pool address', (v) => { try { new PublicKey(v || ''); return true; } catch { return false; } }),
    tokenAAmount: yup.string().test('is-positive-or-zero', 'Amount must be >= 0', (v) => !v || !isNaN(parseFloat(v)) && parseFloat(v) >= 0).required('Token A amount required'),
    tokenBAmount: yup.string().test('is-positive-or-zero', 'Amount must be >= 0', (v) => !v || !isNaN(parseFloat(v)) && parseFloat(v) >= 0).required('Token B amount required'),
    tokenInputLogic: yup.mixed().test(
      'exactly-one-token-amount-provided',
      'Provide amount for Token A OR Token B (not both)',
      function() {
        const amountA = parseFloat(this.parent.tokenAAmount || '0');
        const amountB = parseFloat(this.parent.tokenBAmount || '0');
        return (amountA > 0 && amountB === 0) || (amountA === 0 && amountB > 0);
      }
    ),
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

    if (!isValid || !form.governedAccount?.governance?.account || !form.governedAccount?.extensions.transferAddress || !wallet?.publicKey || !connection.current) {
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructionsSigners };
    }

    try {
      const owner = form.governedAccount.extensions.transferAddress;
      const funder = wallet.publicKey;
      if (!wallet.signTransaction) throw new Error("Wallet does not support signing.");
      const provider = new AnchorProvider(connection.current, wallet as any, AnchorProvider.defaultOptions());
      const program = new Program(WhirlpoolIDL, ORCA_WHIRLPOOL_PROGRAM_ID, provider);
      const poolPubkey = new PublicKey(form.poolAddress);

      // Fetch pool account data manually
      console.log(`Fetching pool account info for: ${poolPubkey.toBase58()}`); // Log Address
      const poolAccountInfo = await connection.current.getAccountInfo(poolPubkey, "confirmed");
      if (!poolAccountInfo) throw new Error(`Whirlpool account not found: ${poolPubkey.toBase58()}`);
      const poolDataBuffer = poolAccountInfo.data;
      console.log(`Pool data buffer (length ${poolDataBuffer.length}):`, poolDataBuffer.toString('hex')); // Log Buffer

      // Manually parse required fields (VERIFY OFFSETS)
      const mintAOffset = 100;
      const mintBOffset = 180;
      const vaultAOffset = 132;
      const vaultBOffset = 212;
      const tickSpacingOffset = 41;
      const sqrtPriceOffset = 64;
      const tickCurrentIndexOffset = 80;

      console.log(`Parsing Mint A at offset ${mintAOffset}`); // Log Offset
      const tokenMintA = parsePublicKey(poolDataBuffer, mintAOffset);
      console.log(`Parsed Mint A: ${tokenMintA?.toBase58()}`); // Log Parsed Key

      console.log(`Parsing Mint B at offset ${mintBOffset}`); // Log Offset
      const tokenMintB = parsePublicKey(poolDataBuffer, mintBOffset);
      console.log(`Parsed Mint B: ${tokenMintB?.toBase58()}`); // Log Parsed Key

      const tokenVaultA = parsePublicKey(poolDataBuffer, vaultAOffset);
      const tokenVaultB = parsePublicKey(poolDataBuffer, vaultBOffset);
      const tickSpacing = parseUInt16(poolDataBuffer, tickSpacingOffset);
      const sqrtPrice = parseBN128(poolDataBuffer, sqrtPriceOffset);
      const tickCurrentIndex = parseInt32(poolDataBuffer, tickCurrentIndexOffset);
      console.log(`Parsed tickSpacing: ${tickSpacing}, sqrtPrice: ${sqrtPrice.toString()}, tickCurrentIndex: ${tickCurrentIndex}`); // Log other parsed

      // Check if mints are valid before proceeding
      if (!tokenMintA || !tokenMintB) {
        throw new Error("Failed to parse valid token mints from pool data buffer.");
      }

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
      const amountA_BN = decimalAmountToBN(amountADecimal, decimalsA); const amountB_BN = decimalAmountToBN(amountBDecimal, decimalsB);

      // Use estimateMaxLiquidityFromTokenAmounts (4 args)
      const tokenAmounts: TokenAmounts = { tokenA: amountA_BN, tokenB: amountB_BN };
      const liquidityAmount = PoolUtil.estimateMaxLiquidityFromTokenAmounts(
        sqrtPrice, tickLowerIndex, tickUpperIndex, tokenAmounts as any
      );
      if (liquidityAmount.isZero()) throw new Error("Calculated liquidity is zero.");

      // Calculate tokenMaxA/B based on liquidity and slippage
      const { tokenA: quoteTokenA, tokenB: quoteTokenB } = PoolUtil.getTokenAmountsFromLiquidity(
        liquidityAmount, sqrtPrice,
        PriceMath.tickIndexToSqrtPriceX64(tickLowerIndex),
        PriceMath.tickIndexToSqrtPriceX64(tickUpperIndex),
        true // round up
      );
      const slippageToleranceBps = new BN(form.slippageBps);
      const tokenMaxA = quoteTokenA.mul(new BN(10000).add(slippageToleranceBps)).div(new BN(10000));
      const tokenMaxB = quoteTokenB.mul(new BN(10000).add(slippageToleranceBps)).div(new BN(10000));


      const positionMintKeypair = Keypair.generate();
      prerequisiteInstructionsSigners.push(positionMintKeypair);

      // Use workaround ATA functions
      const [{ address: funderTokenAccountA, instruction: createFunderAtaA }, { address: funderTokenAccountB, instruction: createFunderAtaB }] = await Promise.all([
        getOrCreateATAInstructionWorkaround(connection.current, tokenMintA, funder, funder, false),
        getOrCreateATAInstructionWorkaround(connection.current, tokenMintB, funder, funder, false),
      ]);
      if (createFunderAtaA) prerequisiteInstructions.push(createFunderAtaA);
      if (createFunderAtaB) prerequisiteInstructions.push(createFunderAtaB);

      const [{ instruction: createOwnerAtaA }, { instruction: createOwnerAtaB }] = await Promise.all([
        getOrCreateATAInstructionWorkaround(connection.current, tokenMintA, owner, funder, true),
        getOrCreateATAInstructionWorkaround(connection.current, tokenMintB, owner, funder, true),
      ]);
      if (createOwnerAtaA) prerequisiteInstructions.push(createOwnerAtaA);
      if (createOwnerAtaB) prerequisiteInstructions.push(createOwnerAtaB);


      const positionMetadataPda = PDAUtil.getPositionMetadata(positionMintKeypair.publicKey);
      const positionPda = PDAUtil.getPosition(program.programId, positionMintKeypair.publicKey);
      const ownerPositionTokenAccount = await findAssociatedTokenAddress(owner, positionMintKeypair.publicKey, true);

      // --- Build Instructions Manually ---

      // 1. Open Position Instruction
      const openPositionParams = {
        liquidityAmount: new BN(0), tokenMaxA: new BN(0), tokenMaxB: new BN(0),
        tickLowerIndex: tickLowerIndex, tickUpperIndex: tickUpperIndex,
        positionBump: positionPda.bump, metadataBump: positionMetadataPda.bump,
        funder: funder, owner: owner, position: positionPda.publicKey,
        positionMint: positionMintKeypair.publicKey, positionTokenAccount: ownerPositionTokenAccount,
        tokenOwnerAccountA: funderTokenAccountA, tokenOwnerAccountB: funderTokenAccountB,
        tokenVaultA: tokenVaultA, tokenVaultB: tokenVaultB, whirlpool: poolPubkey,
        metadataUpdateAuthority: funder, positionMetadataAccount: positionMetadataPda.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: METAPLEX_METADATA_PROGRAM_ID,
      };
      const openPositionIx = WhirlpoolIx.openPositionWithMetadataIx(program, openPositionParams);
      mainInstructions.push(openPositionIx as unknown as TransactionInstruction);

      // 2. Increase Liquidity Instruction
      const increaseLiquidityParams = {
        liquidityAmount: liquidityAmount, tokenMaxA: tokenMaxA, tokenMaxB: tokenMaxB,
        whirlpool: poolPubkey, positionAuthority: owner, position: positionPda.publicKey,
        positionTokenAccount: ownerPositionTokenAccount, tokenOwnerAccountA: funderTokenAccountA,
        tokenOwnerAccountB: funderTokenAccountB, tokenVaultA: tokenVaultA, tokenVaultB: tokenVaultB,
        tickArrayLower: PDAUtil.getTickArray(program.programId, poolPubkey, TickUtil.getStartTickIndex(tickLowerIndex, tickSpacing)).publicKey,
        tickArrayUpper: PDAUtil.getTickArray(program.programId, poolPubkey, TickUtil.getStartTickIndex(tickUpperIndex, tickSpacing)).publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      };
      const increaseLiqIx = WhirlpoolIx.increaseLiquidityIx(program, increaseLiquidityParams);
      mainInstructions.push(increaseLiqIx as unknown as TransactionInstruction);


      // Build the final transaction FOR SIMULATION
      const finalTx = new Transaction();
      if (prerequisiteInstructions.length > 0) {
        finalTx.add(...prerequisiteInstructions);
      }
      finalTx.add(...mainInstructions);

      finalTx.feePayer = funder;
      finalTx.recentBlockhash = (await connection.current.getLatestBlockhash()).blockhash;

      prerequisiteInstructionsSigners.forEach(signer => {
        if (signer) {
          finalTx.partialSign(signer);
        }
      });

      // Serialize the *entire* transaction for the dry run
      const serializedTx = finalTx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64');

      return {
        serializedInstruction: serializedTx,
        isValid: true,
        governance: form.governedAccount.governance,
        prerequisiteInstructionsSigners,
      };

    } catch (error) {
      const msg = error instanceof Error ? error.message : JSON.stringify(error);
      console.error("Error in getInstruction:", error);
      setFormErrors({ _error: `Failed to create instruction: ${msg}` });
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructionsSigners: [] };
    }
  }

  const inputs: InstructionInput[] = [
    { label: 'Position Owner (Governance Account)', initialValue: form.governedAccount, name: 'governedAccount', type: InstructionInputType.GOVERNED_ACCOUNT, shouldBeGoverned, governance, options: assetAccounts.filter(acc => !!acc.extensions.transferAddress), },
    { label: 'Whirlpool Address', initialValue: form.poolAddress, name: 'poolAddress', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Full Range Position?', initialValue: form.isFullRange, name: 'isFullRange', type: InstructionInputType.SWITCH, },
    ...(!form.isFullRange ? [
      { label: 'Lower Price', initialValue: form.lowerPrice, name: 'lowerPrice', type: InstructionInputType.INPUT, inputType: 'text', },
      { label: 'Upper Price', initialValue: form.upperPrice, name: 'upperPrice', type: InstructionInputType.INPUT, inputType: 'text', },
    ] : []),
    { label: 'Token A Amount (Provide ONE amount)', initialValue: form.tokenAAmount, name: 'tokenAAmount', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Token B Amount (Provide ONE amount)', initialValue: form.tokenBAmount, name: 'tokenBAmount', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Acceptable Slippage (BPS)', initialValue: form.slippageBps, name: 'slippageBps', type: InstructionInputType.INPUT, inputType: 'number', step: 1, }
  ];

  useEffect(() => {
    handleSetInstructions({ governedAccount: form.governedAccount?.governance, getInstruction, }, index);
  }, [form, governance, index, handleSetInstructions]);

  return ( <InstructionForm outerForm={form} setForm={setForm} inputs={inputs} setFormErrors={setFormErrors} formErrors={formErrors} /> );
}
