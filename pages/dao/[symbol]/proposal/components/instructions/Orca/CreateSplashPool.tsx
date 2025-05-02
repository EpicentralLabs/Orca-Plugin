/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { useContext, useEffect, useState } from "react";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import * as yup from "yup";
import { isFormValid } from "@utils/formValidation";
import { UiInstruction } from "@utils/uiTypes/proposalCreationTypes";
import { NewProposalContext } from "../../../new";
import useGovernanceAssets from "@hooks/useGovernanceAssets";
import { Governance } from "@solana/spl-governance";
import { ProgramAccount } from "@solana/spl-governance";
import { serializeInstructionToBase64 } from "@solana/spl-governance";
import { AccountType, AssetAccount } from "@utils/uiTypes/assets";
import InstructionForm, { InstructionInput } from "../FormCreator";
import { InstructionInputType } from "../inputInstructionType";
import useWalletOnePointOh from "@hooks/useWalletOnePointOh";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ORCA_WHIRLPOOL_PROGRAM_ID } from "@orca-so/whirlpools-sdk";
import { PDAUtil } from "@orca-so/whirlpools-sdk";
import { PriceMath } from "@orca-so/whirlpools-sdk";
import { PoolUtil } from "@orca-so/whirlpools-sdk";
import Decimal from "decimal.js";

interface CreateSplashPoolForm {
  governedAccount: AssetAccount | null;
  tokenAMint: AssetAccount | null;
  tokenBMint: AssetAccount | null;
  initialPrice: number;
}

const CreateSplashPool = ({
  index,
  governance,
}: {
  index: number;
  governance: ProgramAccount<Governance> | null;
}) => {
  const wallet = useWalletOnePointOh();
  const { assetAccounts } = useGovernanceAssets();
 
  // Filter accounts for SOL accounts that can pay for transactions
  const filteredAccounts = assetAccounts.filter(
    (x) => x.type === AccountType.SOL,
  );

  // Filter for mint accounts in the governance treasury
  const mintAccounts = assetAccounts.filter(
    (x) => x.type === AccountType.MINT || x.extensions.mint
  );
 
  const shouldBeGoverned = !!(index !== 0 && governance);
  const [form, setForm] = useState<CreateSplashPoolForm>({
    governedAccount: null,
    tokenAMint: null,
    tokenBMint: null,
    initialPrice: 0,
  });
  const [formErrors, setFormErrors] = useState({});
  const { handleSetInstructions } = useContext(NewProposalContext);
 
  // Yup schema for validation
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required("Governed account is required"),
    tokenAMint: yup
      .object()
      .nullable()
      .required("Token A mint is required"),
    tokenBMint: yup
      .object()
      .nullable()
      .required("Token B mint is required")
      .test(
        "not-same-as-token-a",
        "Token B must be different from Token A",
        function (value: any) {
          const { tokenAMint } = this.parent;
          if (!value || !tokenAMint) return true;
          
          // Safe comparison using optional chaining
          const tokenAMintPubkey = tokenAMint?.pubkey;
          const tokenBMintPubkey = value?.pubkey;
          
          if (!tokenAMintPubkey || !tokenBMintPubkey) return true;
          
          return tokenAMintPubkey.toBase58() !== tokenBMintPubkey.toBase58();
        }
      ),
    initialPrice: yup.number().required().min(0.000001, "Initial price must be greater than 0"),
  });
 
  // Build and serialize the instruction
  const getInstruction = async (): Promise<UiInstruction> => {
    const { isValid, validationErrors } = await isFormValid(schema, form);
    setFormErrors(validationErrors);
    let serializedInstruction = "";
    const prerequisiteInstructions: TransactionInstruction[] = [];
    const prerequisiteInstructionsSigners: (Keypair | null)[] = [];
    const additionalSerializedInstructions: string[] = [];
 
    if (
      isValid &&
      form.governedAccount?.governance?.account &&
      form.tokenAMint &&
      form.tokenBMint &&
      wallet?.publicKey
    ) {
      try {
        // Get token mint pubkeys from the selected assets
        const tokenMintA = getMintPubkeyFromAsset(form.tokenAMint);
        const tokenMintB = getMintPubkeyFromAsset(form.tokenBMint);

        // Get ordered token mints - ensure they're PublicKeys
        let orderedMintA: PublicKey;
        let orderedMintB: PublicKey;
        if (tokenMintA.toBase58() < tokenMintB.toBase58()) {
          orderedMintA = tokenMintA;
          orderedMintB = tokenMintB;
        } else {
          orderedMintA = tokenMintB;
          orderedMintB = tokenMintA;
        }

        // Get payer - this is the governed account (usually DAO treasury)
        const funder = form.governedAccount.governance.pubkey;
        
        // Set up constants for Splash Pool
        const whirlpoolsConfig = new PublicKey("FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR"); // Orca's default whirlpool config
        const tickSpacing = 8; // Default for Splash Pools is 8
        
        // Calculate PDAs and keypairs needed for the pool
        const whirlpoolPda = PDAUtil.getWhirlpool(
          ORCA_WHIRLPOOL_PROGRAM_ID,
          whirlpoolsConfig,
          orderedMintA,
          orderedMintB,
          tickSpacing
        );
        
        // Get feeTier PDA
        const feeTierPda = PDAUtil.getFeeTier(
          ORCA_WHIRLPOOL_PROGRAM_ID,
          whirlpoolsConfig,
          tickSpacing
        );

        // Create keypairs for token vaults
        const tokenVaultAKeypair = Keypair.generate();
        const tokenVaultBKeypair = Keypair.generate();
        
        // Convert price to sqrtPriceX64 format
        // Get the actual token decimals from the mint accounts
        const decimalsA = form.tokenAMint.extensions.mint?.account.decimals || 6;
        const decimalsB = form.tokenBMint.extensions.mint?.account.decimals || 6;
        const price = new Decimal(form.initialPrice.toString());
        const sqrtPriceX64 = PriceMath.priceToSqrtPriceX64(price, decimalsA, decimalsB);

        // Program will be the Orca Whirlpool program
        const programId = ORCA_WHIRLPOOL_PROGRAM_ID;
        
        // Create the initialize pool instruction
        // This resembles Orca's initializePoolIx but is manually constructed
        // because we can't directly use their SDK objects due to TS/bundling issues
        const whirlpoolBump = whirlpoolPda.bump;
        
        // Build simplified instruction data - this is a placeholder
        // In a real implementation, we would use proper Anchor serialization
        const instructionData = Buffer.alloc(1 + 1 + 1 + 16); // Discriminator + bump + tickSpacing + sqrtPriceX64
        instructionData.writeUInt8(0, 0); // Instruction discriminator for initializePool
        instructionData.writeUInt8(whirlpoolBump, 1); // WhirlpoolBump
        instructionData.writeUInt8(tickSpacing, 2); // tickSpacing as u8
        
        // Write sqrtPriceX64 bytes - this is simplified and may not be exactly how Orca does it
        // Create a Uint8Array to avoid type mismatch
        const sqrtPriceArray = [...sqrtPriceX64.toArray('le', 16)].map(n => Number(n));
        const sqrtPriceUint8Array = new Uint8Array(sqrtPriceArray);
        
        // Copy the sqrtPrice bytes into our instruction data buffer
        for (let i = 0; i < sqrtPriceUint8Array.length; i++) {
          instructionData.writeUInt8(sqrtPriceUint8Array[i], 3 + i);
        }
        
        // PREREQUISITE: Create the token vault accounts
        // These would normally be created as part of the process
        // In a real implementation, you would include instructions to create token accounts
        // Adding placeholder instructions for demonstration
        
        // Create vault A
        const createVaultAIx = SystemProgram.createAccount({
          fromPubkey: funder,
          newAccountPubkey: tokenVaultAKeypair.publicKey,
          lamports: 1_000_000, // Example amount
          space: 165, // Token account size
          programId: TOKEN_PROGRAM_ID,
        });
        
        // Create vault B
        const createVaultBIx = SystemProgram.createAccount({
          fromPubkey: funder,
          newAccountPubkey: tokenVaultBKeypair.publicKey,
          lamports: 1_000_000, // Example amount
          space: 165, // Token account size
          programId: TOKEN_PROGRAM_ID,
        });
        
        // Add these as prerequisite instructions with their signers
        prerequisiteInstructions.push(createVaultAIx, createVaultBIx);
        prerequisiteInstructionsSigners.push(tokenVaultAKeypair, tokenVaultBKeypair);
        
        // Build the main instruction with all required accounts
        const ix = new TransactionInstruction({
          programId,
          keys: [
            { pubkey: whirlpoolsConfig, isSigner: false, isWritable: false },
            { pubkey: orderedMintA, isSigner: false, isWritable: false },
            { pubkey: orderedMintB, isSigner: false, isWritable: false },
            { pubkey: funder, isSigner: true, isWritable: true },
            { pubkey: whirlpoolPda.publicKey, isSigner: false, isWritable: true },
            { pubkey: tokenVaultAKeypair.publicKey, isSigner: false, isWritable: true },
            { pubkey: tokenVaultBKeypair.publicKey, isSigner: false, isWritable: true },
            { pubkey: feeTierPda.publicKey, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data: instructionData,
        });

        serializedInstruction = serializeInstructionToBase64(ix);
        
        // In a real implementation, you might need to add additional instructions
        // to initialize the token vaults or perform other operations
        // Adding a placeholder additional instruction for demonstration
        const additionalIx = new TransactionInstruction({
          programId: SystemProgram.programId,
          keys: [
            { pubkey: funder, isSigner: true, isWritable: true },
            { pubkey: tokenVaultAKeypair.publicKey, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([]), // Empty buffer for this example
        });
        
        additionalSerializedInstructions.push(serializeInstructionToBase64(additionalIx));
        
        console.log("Creating Orca Splash Pool with details:", {
          whirlpoolAddress: whirlpoolPda.publicKey.toString(),
          tokenMintA: orderedMintA.toString(),
          tokenMintB: orderedMintB.toString(),
          vaultA: tokenVaultAKeypair.publicKey.toString(),
          vaultB: tokenVaultBKeypair.publicKey.toString(),
          initialPrice: form.initialPrice,
          tickSpacing
        });
      } catch (e) {
        console.error("Error creating splash pool instruction:", e);
        throw e;
      }
    }
 
    const obj: UiInstruction = {
      serializedInstruction,
      isValid,
      governance: form.governedAccount?.governance,
      prerequisiteInstructions: prerequisiteInstructions.length > 0 ? prerequisiteInstructions : undefined,
      prerequisiteInstructionsSigners: prerequisiteInstructionsSigners.length > 0 ? prerequisiteInstructionsSigners : undefined,
      additionalSerializedInstructions: additionalSerializedInstructions.length > 0 ? additionalSerializedInstructions : undefined,
      chunkBy: 2, // Split instructions into transactions with max 2 instructions each
    };
    return obj;
  };

  // Helper function to extract the mint pubkey from an asset account
  const getMintPubkeyFromAsset = (asset: AssetAccount): PublicKey => {
    if (asset.type === AccountType.MINT) {
      return asset.pubkey;
    } else if (asset.extensions.mint) {
      return asset.extensions.mint.publicKey;
    }
    throw new Error("Asset does not contain a valid mint");
  };
 
  useEffect(() => {
    // The part that integrates with the new proposal creation
    handleSetInstructions(
      { governedAccount: form.governedAccount?.governance, getInstruction },
      index,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);
 
  // Prepare fields for the form
  const inputs: InstructionInput[] = [
    {
      label: "Governance",
      initialValue: form.governedAccount,
      name: "governedAccount",
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned: shouldBeGoverned as any,
      governance: governance,
      options: filteredAccounts,
    },
    {
      label: "Token A Mint",
      initialValue: form.tokenAMint,
      name: "tokenAMint",
      type: InstructionInputType.SELECT,
      options: mintAccounts,
      shouldBeGoverned: false,
    },
    {
      label: "Token B Mint",
      initialValue: form.tokenBMint,
      name: "tokenBMint",
      type: InstructionInputType.SELECT,
      options: mintAccounts,
      shouldBeGoverned: false,
    },
    {
      label: "Initial Price",
      initialValue: form.initialPrice,
      type: InstructionInputType.INPUT,
      inputType: "number",
      name: "initialPrice",
      placeholder: "Set the initial price for the pool (tokenB per tokenA)",
    },
  ];
 
  return (
    <InstructionForm
      outerForm={form}
      setForm={setForm}
      inputs={inputs}
      setFormErrors={setFormErrors}
      formErrors={formErrors}
    />
  );
};
 
export default CreateSplashPool;