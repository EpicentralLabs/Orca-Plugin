/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { useContext, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
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
import useLegacyConnectionContext from "@hooks/useLegacyConnectionContext";
import { ORCA_WHIRLPOOL_PROGRAM_ID } from "@orca-so/whirlpools-sdk";
import Decimal from "decimal.js";

interface CreateSplashPoolForm {
  governedAccount: AssetAccount | null;
  tokenAMint: AssetAccount | null;
  tokenBMint: AssetAccount | null;
  initialPrice: number;
}

// This is the Orca whirlpool config account on mainnet
const ORCA_WHIRLPOOL_CONFIG = new PublicKey("FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR"); 

const CreateSplashPool = ({
  index,
  governance,
}: {
  index: number;
  governance: ProgramAccount<Governance> | null;
}) => {
  const wallet = useWalletOnePointOh();
  const connection = useLegacyConnectionContext();
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
    
    if (
      !isValid ||
      !form.governedAccount?.governance?.account ||
      !form.tokenAMint ||
      !form.tokenBMint ||
      !wallet?.publicKey ||
      !connection
    ) {
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
      };
    }
    
    try {
      // Get token mint pubkeys from the selected assets
      const tokenMintA = getMintPubkeyFromAsset(form.tokenAMint);
      const tokenMintB = getMintPubkeyFromAsset(form.tokenBMint);

      // Get payer - this is the governed account (usually DAO treasury)
      const funder = form.governedAccount.governance.pubkey;
      
      // Orca example shows using a WhirlpoolClient to create a splash pool
      // However, for the sake of simplicity in this integration, we'll create 
      // the instructions more directly to avoid TypeScript errors with the SDK

      // Import orcaModule first to avoid TypeScript errors
      const orcaModule = await import('@orca-so/whirlpools-sdk');
      
      // Using the pattern from other instructions like CollectPoolFees.tsx
      // Create a fake wallet and context to use the Orca SDK's instruction builders
      const fakeWallet = {
        publicKey: funder, 
        signTransaction: async (tx: any) => tx,
        signAllTransactions: async (txs: any) => txs
      };
      
      // Initialize an anchor provider
      const { AnchorProvider } = await import('@coral-xyz/anchor');
      const provider = new AnchorProvider(connection.current, fakeWallet, {});
      
      // Get the context
      const { Program } = await import('@coral-xyz/anchor');
      const { IDL } = await import('@orca-so/whirlpools-sdk/dist/artifacts/whirlpool');
      const program = new Program(IDL, ORCA_WHIRLPOOL_PROGRAM_ID, provider);
      const ctx = orcaModule.WhirlpoolContext.fromWorkspace(
        provider,
        program,
        undefined,
        undefined, 
        {
          accountResolverOptions: { allowPDAOwnerAddress: true, createWrappedSolAccountMethod: "keypair" }
        }
      );
      
      // Convert the price to decimal
      const initialPrice = new Decimal(form.initialPrice.toString());
      
      try {
        // Call the createSplashPool function to get the transaction
        const whirlpoolClient = orcaModule.buildWhirlpoolClient(ctx);
        
        const { tx } = await whirlpoolClient.createSplashPool(
          ORCA_WHIRLPOOL_CONFIG,
          tokenMintA,
          tokenMintB,
          initialPrice,
          funder
        );
        
        // Extract and serialize the instructions
        // We have to access the private instructions property differently
        // Accessing tx["instructions"] to get around TypeScript private property restrictions
        const rawInstructions = tx["instructions"];
        
        if (!rawInstructions || !Array.isArray(rawInstructions) || rawInstructions.length === 0) {
          throw new Error("Failed to generate instructions for pool creation");
        }
        
        // Serialize all instructions
        const serializedInstruction = serializeInstructionToBase64(rawInstructions[0]);
        const additionalSerializedInstructions = rawInstructions.slice(1).map(ix => 
          serializeInstructionToBase64(ix)
        );
        
        console.log("Creating Orca Splash Pool with details:", {
          tokenMintA: tokenMintA.toString(),
          tokenBMint: tokenMintB.toString(),
          initialPrice: form.initialPrice.toString(),
          instructionCount: rawInstructions.length
        });
            
        return {
          serializedInstruction,
          isValid: true,
          governance: form.governedAccount?.governance,
          additionalSerializedInstructions: additionalSerializedInstructions.length > 0 ? additionalSerializedInstructions : undefined,
          prerequisiteInstructions: [], // Add any setup instructions that need to run before main instruction
          prerequisiteInstructionsSigners: [], // Add any signers needed for prerequisite instructions
          chunkBy: 1, // Controls how instructions are grouped in transactions
        };
      } catch (e) {
        console.error("Error generating splash pool instructions:", e);
        throw e;
      }
    } catch (e) {
      console.error("Error creating splash pool instruction:", e);
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
      };
    }
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