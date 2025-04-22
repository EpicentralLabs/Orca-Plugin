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
  TransactionInstruction, // Import directly
  Keypair, // Import Keypair
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY // Import Rent Sysvar
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
  PDAUtil,
  WhirlpoolIx,
  IGNORE_CACHE,
  InitPoolParams, // Import InitPoolParams type for clarity
} from '@orca-so/whirlpools-sdk';
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Define TICK_SPACING constants locally
const TICK_SPACING_STABLE = 8;
const TICK_SPACING_STANDARD = 64;
const VALID_TICK_SPACINGS = [1, TICK_SPACING_STABLE, TICK_SPACING_STANDARD, 128];
const DEFAULT_TICK_SPACING = TICK_SPACING_STANDARD;

interface CreatePoolForm {
  governedAccount?: AssetAccount;
  tokenAMint: string;
  tokenBMint: string;
  initialPrice: string;
  tickSpacing: number;
}

const uiAmountToDecimal = (amount: string): Decimal => {
  try { return new Decimal(amount || '0'); } catch { return new Decimal(0); }
};

// Helper to fetch mint decimals manually
async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`Mint not found: ${mint.toBase58()}`);
  if (mintInfo.data.length !== 82) throw new Error("Invalid mint account size");
  return mintInfo.data.readUInt8(44); // Decimals are at offset 44
}


export default function CreatePool({ index, governance }: { index: number; governance: ProgramAccount<Governance> | null; }) {
  const { handleSetInstructions } = useContext(NewProposalContext);
  const connection = useLegacyConnectionContext();
  const { assetAccounts } = useGovernanceAssets();
  const wallet = useWalletOnePointOh();
  const [form, setForm] = useState<CreatePoolForm>({
    tokenAMint: '', tokenBMint: '', initialPrice: '0.01', tickSpacing: DEFAULT_TICK_SPACING,
  });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance);

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account selection is required'),
    tokenAMint: yup.string().required('Token A mint is required').test('is-pubkey', 'Invalid Token A Mint', (v) => { try { new PublicKey(v || ''); return true; } catch { return false; } }),
    tokenBMint: yup.string().required('Token B mint is required').test('is-pubkey', 'Invalid Token B Mint', (v) => { try { new PublicKey(v || ''); return true; } catch { return false; } }).test('not-same-as-A', 'Mints cannot be the same', function(v) { return this.parent.tokenAMint !== v; }),
    initialPrice: yup.string().required('Initial price is required').test('is-positive', 'Price must be positive', (v) => { try { return new Decimal(v || '0').isPositive(); } catch { return false; } }),
    tickSpacing: yup.number().required('Tick Spacing required').oneOf(VALID_TICK_SPACINGS, `Tick spacing must be one of: ${VALID_TICK_SPACINGS.join(', ')}`),
  });

  async function getInstruction(): Promise<UiInstruction> {
    setFormErrors({});
    const isValid = await validateInstruction({ schema, form, setFormErrors });
    const prerequisiteInstructions: TransactionInstruction[] = [];
    const prerequisiteInstructionsSigners: Keypair[] = []; // Signers for prerequisite IXs (vaults)
    const mainInstructions: TransactionInstruction[] = []; // Use web3.js type
    const additionalSerializedInstructions: string[] = [];

    if (!isValid || !form.governedAccount?.governance?.account || !wallet?.publicKey || !connection.current) {
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions, prerequisiteInstructionsSigners, additionalSerializedInstructions };
    }

    try {
      const funder = wallet.publicKey;
      if (!wallet.signTransaction) throw new Error("Wallet does not support signing.");
      const provider = new AnchorProvider(connection.current, wallet as any, AnchorProvider.defaultOptions());
      const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);

      const tokenAMintPubKey = new PublicKey(form.tokenAMint);
      const tokenBMintPubKey = new PublicKey(form.tokenBMint);
      const tickSpacing = form.tickSpacing;

      const [decimalsA, decimalsB] = await Promise.all([
        getMintDecimals(connection.current, tokenAMintPubKey),
        getMintDecimals(connection.current, tokenBMintPubKey)
      ]);

      const initialPriceDecimal = uiAmountToDecimal(form.initialPrice);
      const initialSqrtPriceX64 = PriceMath.priceToSqrtPriceX64(initialPriceDecimal, decimalsA, decimalsB);

      // Derive PDAs
      const [whirlpoolsConfigKey] = await PublicKey.findProgramAddress(
        [Buffer.from("whirlpools_config")], ctx.program.programId
      );
      const feeTierPdaInfo = PDAUtil.getFeeTier(ctx.program.programId, whirlpoolsConfigKey, tickSpacing);
      const poolPdaInfo = PDAUtil.getWhirlpool(ctx.program.programId, whirlpoolsConfigKey, tokenAMintPubKey, tokenBMintPubKey, tickSpacing);

      // Check if Fee Tier exists
      let defaultFeeRate: number;
      switch (tickSpacing) {
        case 1: defaultFeeRate = 100; break;
        case TICK_SPACING_STABLE: defaultFeeRate = 500; break;
        case TICK_SPACING_STANDARD: defaultFeeRate = 3000; break;
        case 128: defaultFeeRate = 10000; break;
        default: throw new Error(`Unsupported tick spacing for default fee rate: ${tickSpacing}`);
      }

      const feeTierAccount = await ctx.connection.getAccountInfo(feeTierPdaInfo.publicKey);
      if (!feeTierAccount) {
        console.log(`Initializing Fee Tier for tick spacing ${tickSpacing}`);
        const initFeeTierIx = WhirlpoolIx.initializeFeeTierIx(ctx.program, {
          whirlpoolsConfig: whirlpoolsConfigKey,
          feeTierPda: feeTierPdaInfo,
          funder: funder,
          feeAuthority: funder,
          tickSpacing: tickSpacing,
          defaultFeeRate: defaultFeeRate,
        });
        mainInstructions.push(initFeeTierIx as unknown as TransactionInstruction);
      }

      // Generate Keypairs for the Token Vaults
      const tokenVaultAKeypair = Keypair.generate();
      const tokenVaultBKeypair = Keypair.generate();
      // Add vault keypairs as signers for the transaction that creates them
      prerequisiteInstructionsSigners.push(tokenVaultAKeypair);
      prerequisiteInstructionsSigners.push(tokenVaultBKeypair);


      // Prepare parameters for initializePoolIx according to InitPoolParams type
      const initPoolParams: InitPoolParams = {
        whirlpoolsConfig: whirlpoolsConfigKey,
        tokenMintA: tokenAMintPubKey,
        tokenMintB: tokenBMintPubKey,
        whirlpoolPda: poolPdaInfo,
        initSqrtPrice: initialSqrtPriceX64, // Corrected name from SDK type
        funder: funder,
        feeTierKey: feeTierPdaInfo.publicKey,
        tokenVaultAKeypair: tokenVaultAKeypair, // Pass generated keypair
        tokenVaultBKeypair: tokenVaultBKeypair, // Pass generated keypair
        tickSpacing: tickSpacing, // Add tickSpacing as it's part of the type
      };

      // Initialize Pool instruction
      console.log(`Initializing Pool ${poolPdaInfo.publicKey.toBase58()}`);
      const initPoolIx = WhirlpoolIx.initializePoolIx(ctx.program, initPoolParams);
      mainInstructions.push(initPoolIx as unknown as TransactionInstruction);


      // Serialize all main instructions
      mainInstructions.forEach((ix) => {
        additionalSerializedInstructions.push(serializeInstructionToBase64(ix));
      });

    } catch (error) {
      const msg = error instanceof Error ? error.message : JSON.stringify(error);
      setFormErrors({ _error: `Failed to create instruction: ${msg}` });
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions, prerequisiteInstructionsSigners, additionalSerializedInstructions: [] };
    }

    return {
      serializedInstruction: '', // Keep empty
      isValid: true,
      governance: form.governedAccount?.governance,
      prerequisiteInstructions, // Keep empty as vault creation is part of main IX
      prerequisiteInstructionsSigners, // Pass vault signers
      additionalSerializedInstructions, // Pass serialized main instructions
      chunkBy: 2,
    };
  }

  function getFeeTierFromTickSpacing(tickSpacing: number): string {
    switch (tickSpacing) {
      case 1: return "0.01"; case TICK_SPACING_STABLE: return "0.05"; case TICK_SPACING_STANDARD: return "0.30"; case 128: return "1.00"; default: return "Unknown";
    }
  }

  const inputs: InstructionInput[] = [
    { label: 'Governance Account (For Proposal)', initialValue: form.governedAccount, name: 'governedAccount', type: InstructionInputType.GOVERNED_ACCOUNT, shouldBeGoverned, governance, options: assetAccounts, },
    { label: 'Token A Mint', initialValue: form.tokenAMint, name: 'tokenAMint', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Token B Mint', initialValue: form.tokenBMint, name: 'tokenBMint', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Initial Price (Token A in terms of Token B)', initialValue: form.initialPrice, name: 'initialPrice', type: InstructionInputType.INPUT, inputType: 'text', },
    { label: 'Tick Spacing (Fee Tier)', initialValue: form.tickSpacing, name: 'tickSpacing', type: InstructionInputType.SELECT, options: VALID_TICK_SPACINGS.map(ts => ({ name: `${ts} (${getFeeTierFromTickSpacing(ts)}%)`, value: ts })), },
  ];

  useEffect(() => {
    handleSetInstructions({ governedAccount: form.governedAccount?.governance, getInstruction, }, index);
  }, [form, governance, index, handleSetInstructions]);

  return ( <InstructionForm outerForm={form} setForm={setForm} inputs={inputs} setFormErrors={setFormErrors} formErrors={formErrors} /> );
}
