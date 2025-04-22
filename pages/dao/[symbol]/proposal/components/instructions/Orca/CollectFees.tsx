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
  IGNORE_CACHE,
  WhirlpoolClient,
  ParsablePosition,
  ParsableWhirlpool,
  WhirlpoolIx,
  PDAUtil,
  PoolUtil,
  TickUtil,
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
// --- End Workaround Helper Functions ---


interface CollectFeesForm {
  governedAccount?: AssetAccount; // Authority over the position NFT
  positionMint: string;
}

// Renamed component slightly for clarity as it collects rewards too
export default function CollectFeesAndRewards({ index, governance }: { index: number; governance: ProgramAccount<Governance> | null; }) {
  const { handleSetInstructions } = useContext(NewProposalContext);
  const connection = useLegacyConnectionContext();
  const { assetAccounts } = useGovernanceAssets();
  const wallet = useWalletOnePointOh();
  const [form, setForm] = useState<CollectFeesForm>({ positionMint: '' });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance);

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account (Position Authority) required'),
    positionMint: yup.string().required('Position NFT Mint required').test('is-pubkey', 'Invalid Position Mint', (v) => { try { new PublicKey(v || ''); return true; } catch { return false; } }),
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
      const positionAuthority = form.governedAccount.extensions.transferAddress;
      const funder = wallet.publicKey; // Funder pays tx fees
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

      // Derive the position token account address
      const positionTokenAccount = await findAssociatedTokenAddress(positionAuthority, positionMintPubKey, true);

      // Get/Create ATAs for Authority (where fees/rewards go)
      const ataInstructions: TransactionInstruction[] = [];
      const [{ address: authorityTokenAccountA, instruction: createAtaA }, { address: authorityTokenAccountB, instruction: createAtaB }] = await Promise.all([
        getOrCreateATAInstructionWorkaround(ctx.connection, poolData.tokenMintA, positionAuthority, funder, true),
        getOrCreateATAInstructionWorkaround(ctx.connection, poolData.tokenMintB, positionAuthority, funder, true),
      ]);
      if (createAtaA) ataInstructions.push(createAtaA); if (createAtaB) ataInstructions.push(createAtaB);

      const rewardDestinations: PublicKey[] = [];
      for (const rewardInfo of poolData.rewardInfos) {
        if (PoolUtil.isRewardInitialized(rewardInfo)) {
          const { address: rewardAta, instruction: createRewardAtaIx } = await getOrCreateATAInstructionWorkaround(ctx.connection, rewardInfo.mint, positionAuthority, funder, true);
          if (createRewardAtaIx) ataInstructions.push(createRewardAtaIx);
          rewardDestinations.push(rewardAta);
        } else { rewardDestinations.push(positionAuthority); } // Placeholder
      }
      prerequisiteInstructions.push(...ataInstructions);

      // Build Main Instructions
      const tickArrayLowerPda = PDAUtil.getTickArray(ctx.program.programId, positionData.whirlpool, TickUtil.getStartTickIndex(positionData.tickLowerIndex, poolData.tickSpacing));
      const tickArrayUpperPda = PDAUtil.getTickArray(ctx.program.programId, positionData.whirlpool, TickUtil.getStartTickIndex(positionData.tickUpperIndex, poolData.tickSpacing));

      // 1. Update Fees & Rewards (Good practice before collecting)
      const updateIx = WhirlpoolIx.updateFeesAndRewardsIx(ctx.program, {
        whirlpool: positionData.whirlpool, position: positionPda.publicKey, tickArrayLower: tickArrayLowerPda.publicKey, tickArrayUpper: tickArrayUpperPda.publicKey,
      });
      mainInstructions.push(updateIx as unknown as TransactionInstruction);

      // 2. Collect Fees
      const collectFeesIx = WhirlpoolIx.collectFeesIx(ctx.program, {
        whirlpool: positionData.whirlpool, positionAuthority: positionAuthority, position: positionPda.publicKey,
        positionTokenAccount: positionTokenAccount, // Use derived address
        tokenOwnerAccountA: authorityTokenAccountA, tokenOwnerAccountB: authorityTokenAccountB, tokenVaultA: poolData.tokenVaultA, tokenVaultB: poolData.tokenVaultB,
      });
      mainInstructions.push(collectFeesIx as unknown as TransactionInstruction);

      // 3. Collect Rewards
      poolData.rewardInfos.forEach((rewardInfo, index) => {
        if (PoolUtil.isRewardInitialized(rewardInfo)) {
          const collectRewardIx = WhirlpoolIx.collectRewardIx(ctx.program, {
            whirlpool: positionData.whirlpool, positionAuthority: positionAuthority, position: positionPda.publicKey,
            positionTokenAccount: positionTokenAccount, // Use derived address
            rewardOwnerAccount: rewardDestinations[index], rewardVault: rewardInfo.vault, rewardIndex: index,
          });
          mainInstructions.push(collectRewardIx as unknown as TransactionInstruction);
        }
      });

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
      chunkBy: 2, // Adjust as needed
    };
  }

  const inputs: InstructionInput[] = [
    { label: 'Position Authority (Governance Account)', initialValue: form.governedAccount, name: 'governedAccount', type: InstructionInputType.GOVERNED_ACCOUNT, shouldBeGoverned, governance, options: assetAccounts.filter(acc => !!acc.extensions.transferAddress), },
    { label: 'Position NFT Mint Address', initialValue: form.positionMint, name: 'positionMint', type: InstructionInputType.INPUT, inputType: 'text', },
  ];

  useEffect(() => {
    handleSetInstructions({ governedAccount: form.governedAccount?.governance, getInstruction, }, index);
  }, [form, governance, index, handleSetInstructions]);

  return ( <InstructionForm outerForm={form} setForm={setForm} inputs={inputs} setFormErrors={setFormErrors} formErrors={formErrors} /> );
}
