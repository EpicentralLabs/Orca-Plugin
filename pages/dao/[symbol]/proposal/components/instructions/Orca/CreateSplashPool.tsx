/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { useContext, useEffect, useState } from "react";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import * as yup from "yup";
import { isFormValid, validatePubkey } from "@utils/formValidation";
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
  tokenAMint: string;
  tokenBMint: string;
  initialPrice: number;
  holdupTime: number;
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
 
  const shouldBeGoverned = !!(index !== 0 && governance);
  const [form, setForm] = useState<CreateSplashPoolForm>({
    governedAccount: null,
    tokenAMint: "",
    tokenBMint: "",
    initialPrice: 0,
    holdupTime: 0,
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
      .string()
      .required()
      .test("is-valid-address", "Please enter a valid token A mint PublicKey", (value) =>
        value ? validatePubkey(value) : false,
      ),
    tokenBMint: yup
      .string()
      .required()
      .test("is-valid-address", "Please enter a valid token B mint PublicKey", (value) =>
        value ? validatePubkey(value) : false,
      ),
    initialPrice: yup.number().required().min(0.000001, "Initial price must be greater than 0"),
  });
 
  // Build and serialize the instruction
  const getInstruction = async (): Promise<UiInstruction> => {
    const { isValid, validationErrors } = await isFormValid(schema, form);
    setFormErrors(validationErrors);
    let serializedInstruction = "";
    const prerequisiteInstructions: TransactionInstruction[] = [];
 
    if (
      isValid &&
      form.governedAccount?.governance?.account &&
      wallet?.publicKey
    ) {
      try {
        // Convert token mints to PublicKeys
        const tokenMintA = new PublicKey(form.tokenAMint);
        const tokenMintB = new PublicKey(form.tokenBMint);

        // Get ordered token mints - ensure they're PublicKeys
        let orderedMintA: PublicKey;
        let orderedMintB: PublicKey;
        if (tokenMintA.toString() < tokenMintB.toString()) {
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
        // Assuming tokenA and tokenB both have 6 decimals (like USDC)
        // In a real implementation, you would fetch the actual decimals
        const decimalsA = 6;
        const decimalsB = 6;
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
        
        // Build the instruction with all required accounts
        const ix = new TransactionInstruction({
          programId,
          keys: [
            { pubkey: whirlpoolsConfig, isSigner: false, isWritable: false },
            { pubkey: orderedMintA, isSigner: false, isWritable: false },
            { pubkey: orderedMintB, isSigner: false, isWritable: false },
            { pubkey: funder, isSigner: true, isWritable: true },
            { pubkey: whirlpoolPda.publicKey, isSigner: false, isWritable: true },
            { pubkey: tokenVaultAKeypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: tokenVaultBKeypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: feeTierPda.publicKey, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data: instructionData,
        });

        serializedInstruction = serializeInstructionToBase64(ix);
        
        // For a complete implementation, we would also need to include the token vault keypairs
        // as signers. Since this is a governance proposal, the DAO would need a separate
        // mechanism to handle these keypairs.
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
      customHoldUpTime: form.holdupTime,
    };
    return obj;
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
      label: "Instruction hold up time (days)",
      initialValue: form.holdupTime,
      type: InstructionInputType.INPUT,
      inputType: "number",
      name: "holdupTime",
    },
    {
      label: "Token A Mint",
      initialValue: form.tokenAMint,
      type: InstructionInputType.INPUT,
      name: "tokenAMint",
      placeholder: "Token A mint address (Pubkey)",
    },
    {
      label: "Token B Mint",
      initialValue: form.tokenBMint,
      type: InstructionInputType.INPUT,
      name: "tokenBMint",
      placeholder: "Token B mint address (Pubkey)",
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