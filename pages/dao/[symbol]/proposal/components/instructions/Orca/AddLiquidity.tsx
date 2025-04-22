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
  ParsablePosition, // Import ParsablePosition
  WhirlpoolIx,
  WhirlpoolData,
  PositionData,
  TokenAmounts,
} from '@orca-so/whirlpools-sdk';
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';
import { Percentage } from '@orca-so/common-sdk';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';

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
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`Mint not found: ${mint.toBase58()}`);
  if (mintInfo.data.length !== 82) throw new Error("Invalid mint account size");
  return mintInfo.data.readUInt8(44);
}

const uiAmountToDecimal = (amount: string): Decimal => {
  try { return new Decimal(amount || '0'); } catch { return new Decimal(0); }
};

// @ts-ignore
const decimalAmountToBN = (decimalAmount: Decimal, decimals: number): BN => {
  return new BN(decimalAmount.mul(new Decimal(10).pow(decimals)).toFixed(0));
};

// --- End Helper Functions ---


interface AddLiquidityForm {
  governedAccount?: AssetAccount; // Represents the authority over the position NFT
  positionMint: string;          // Mint of the existing position NFT
  tokenAAmount: string;          // Amount of token A to add
  tokenBAmount: string;          // Amount of token B to add
  slippageBps: number;           // Slippage tolerance (used to calculate max tokens)
}

export default function AddLiquidity({ index, governance }: { index: number; governance: ProgramAccount<Governance> | null; }) {
  const { handleSetInstructions } = useContext(NewProposalContext);
  const connection = useLegacyConnectionContext();
  const { assetAccounts } = useGovernanceAssets();
  const wallet = useWalletOnePointOh();
  const [form, setForm] = useState<AddLiquidityForm>({
    positionMint: '', tokenAAmount: '0', tokenBAmount: '0', slippageBps: 50,
  });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance);

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account (Position Authority) required'),
    positionMint: yup.string().required('Position NFT Mint required').test('is-pubkey', 'Invalid Position Mint', (v) => { try { new PublicKey(v || ''); return true; } catch { return false; } }),
    tokenAAmount: yup.string().test('is-positive-or-zero', 'Amount must be >= 0', (v) => !v || !isNaN(parseFloat(v)) && parseFloat(v) >= 0).required('Token A amount required'),
    tokenBAmount: yup.string().test('is-positive-or-zero', 'Amount must be >= 0', (v) => !v || !isNaN(parseFloat(v)) && parseFloat(v) >= 0).required('Token B amount required'),
    tokenInputLogic: yup.mixed().test('at-least-one-positive', 'At least one token amount must be > 0', function() { return parseFloat(this.parent.tokenAAmount || '0') > 0 || parseFloat(this.parent.tokenBAmount || '0') > 0; }),
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

    let tokenMintA: PublicKey | null = null, tokenMintB: PublicKey | null = null;

    try {
      const positionAuthority = form.governedAccount.extensions.transferAddress;
      const funder = wallet.publicKey; // Funder provides tokens and pays fees
      if (!wallet.signTransaction) throw new Error("Wallet does not support signing.");
      const provider = new AnchorProvider(connection.current, wallet as any, AnchorProvider.defaultOptions());
      const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
      const client = buildWhirlpoolClient(ctx);

      const positionMintPubKey = new PublicKey(form.positionMint);
      const positionPda = PDAUtil.getPosition(ctx.program.programId, positionMintPubKey);

      const positionAccountInfo = await ctx.connection.getAccountInfo(positionPda.publicKey, "confirmed");
      if (!positionAccountInfo) throw new Error(`Position account (PDA) not found for mint: ${positionMintPubKey.toBase58()}`);
      const positionData = ParsablePosition.parse(positionPda.publicKey, positionAccountInfo);
      if (!positionData) throw new Error("Failed to parse position data.");
      // Authority check happens implicitly via required signer

      const poolAccountInfo = await ctx.connection.getAccountInfo(positionData.whirlpool, "confirmed");
      if (!poolAccountInfo) throw new Error(`Pool account not found: ${positionData.whirlpool.toBase58()}`);
      const poolData = ParsableWhirlpool.parse(positionData.whirlpool, poolAccountInfo);
      if (!poolData) throw new Error("Failed to parse pool data.");

      tokenMintA = poolData.tokenMintA; tokenMintB = poolData.tokenMintB;
      const { tickSpacing, sqrtPrice, tickCurrentIndex } = poolData;

      const [decimalsA, decimalsB] = await Promise.all([
        getMintDecimals(connection.current, tokenMintA),
        getMintDecimals(connection.current, tokenMintB)
      ]);

      const amountADecimal = uiAmountToDecimal(form.tokenAAmount); const amountBDecimal = uiAmountToDecimal(form.tokenBAmount);
      const amountA_BN = decimalAmountToBN(amountADecimal, decimalsA); const amountB_BN = decimalAmountToBN(amountBDecimal, decimalsB);

      // Estimate liquidity amount based on inputs
      const tokenAmounts: TokenAmounts = { tokenA: amountA_BN, tokenB: amountB_BN };
      const liquidityAmount = PoolUtil.estimateMaxLiquidityFromTokenAmounts(
        sqrtPrice,
        positionData.tickLowerIndex,
        positionData.tickUpperIndex,
        tokenAmounts as any // Cast to bypass potential type issue
      );
      if (liquidityAmount.isZero()) throw new Error("Calculated liquidity increase is zero.");

      // Calculate max amounts based on slippage (add slippage to input amounts)
      const slippageTolerance = new BN(form.slippageBps);
      const tokenMaxA = amountA_BN.mul(new BN(10000).add(slippageTolerance)).div(new BN(10000));
      const tokenMaxB = amountB_BN.mul(new BN(10000).add(slippageTolerance)).div(new BN(10000));

      // Get/Create ATAs for the FUNDER (wallet)
      const [{ address: funderTokenAccountA, instruction: createFunderAtaA }, { address: funderTokenAccountB, instruction: createFunderAtaB }] = await Promise.all([
        getOrCreateATAInstructionWorkaround(ctx.connection, tokenMintA, funder, funder, false),
        getOrCreateATAInstructionWorkaround(ctx.connection, tokenMintB, funder, funder, false),
      ]);
      if (createFunderAtaA) prerequisiteInstructions.push(createFunderAtaA);
      if (createFunderAtaB) prerequisiteInstructions.push(createFunderAtaB);

      // Derive position token account (owned by positionAuthority)
      const positionTokenAccount = await findAssociatedTokenAddress(positionAuthority, positionMintPubKey, true);
      // Derive tick array PDAs
      const tickArrayLowerPda = PDAUtil.getTickArray(ctx.program.programId, positionData.whirlpool, TickUtil.getStartTickIndex(positionData.tickLowerIndex, tickSpacing));
      const tickArrayUpperPda = PDAUtil.getTickArray(ctx.program.programId, positionData.whirlpool, TickUtil.getStartTickIndex(positionData.tickUpperIndex, tickSpacing));

      // Build instruction
      const increaseLiqIx = WhirlpoolIx.increaseLiquidityIx(ctx.program, {
        // Args
        liquidityAmount: liquidityAmount,
        tokenMaxA: tokenMaxA,
        tokenMaxB: tokenMaxB,
        // Accounts
        whirlpool: positionData.whirlpool,
        positionAuthority: positionAuthority,
        position: positionPda.publicKey,
        positionTokenAccount: positionTokenAccount,
        tokenOwnerAccountA: funderTokenAccountA, // Source is funder's ATA
        tokenOwnerAccountB: funderTokenAccountB, // Source is funder's ATA
        tokenVaultA: poolData.tokenVaultA,
        tokenVaultB: poolData.tokenVaultB,
        tickArrayLower: tickArrayLowerPda.publicKey,
        tickArrayUpper: tickArrayUpperPda.publicKey,
        // tokenProgram: TOKEN_PROGRAM_ID, // Removed incorrect parameter
      });
      mainInstructions.push(increaseLiqIx as unknown as TransactionInstruction);

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
      prerequisiteInstructionsSigners, // Should be empty
      additionalSerializedInstructions, // Serialized list of all instructions
      chunkBy: 2,
    };
  }

  const inputs: InstructionInput[] = [
    { label: 'Position Authority (Governance Account)', initialValue: form.governedAccount, name: 'governedAccount', type: InstructionInputType.GOVERNED_ACCOUNT, shouldBeGoverned, governance, options: assetAccounts.filter(acc => !!acc.extensions.transferAddress), },
    { label: 'Position NFT Mint Address', initialValue: form.positionMint, name: 'positionMint', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Token A Amount to Add', initialValue: form.tokenAAmount, name: 'tokenAAmount', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Token B Amount to Add', initialValue: form.tokenBAmount, name: 'tokenBAmount', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Acceptable Slippage (BPS)', initialValue: form.slippageBps, name: 'slippageBps', type: InstructionInputType.INPUT, inputType: 'number', step: 1, }
  ];

  useEffect(() => {
    handleSetInstructions({ governedAccount: form.governedAccount?.governance, getInstruction, }, index);
  }, [form, governance, index, handleSetInstructions]);

  return ( <InstructionForm outerForm={form} setForm={setForm} inputs={inputs} setFormErrors={setFormErrors} formErrors={formErrors} /> );
}
