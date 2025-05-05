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

interface OpenPositionAddLiquidityForm {
  governedAccount: AssetAccount | null;
  whirlpoolAddress: string;
  lowerPrice: number;
  upperPrice: number;
  tokenAmount: number;
  tokenSide: string; // "A" or "B"
  slippage: number;
}

const OpenPositionAddLiquidity = ({
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
 
  const shouldBeGoverned = !!(index !== 0 && governance);
  const [form, setForm] = useState<OpenPositionAddLiquidityForm>({
    governedAccount: null,
    whirlpoolAddress: "",
    lowerPrice: 0,
    upperPrice: 0,
    tokenAmount: 0,
    tokenSide: "A",
    slippage: 1,
  });
  const [formErrors, setFormErrors] = useState({});
  const { handleSetInstructions } = useContext(NewProposalContext);
 
  // Yup schema for validation
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required("Governed account is required"),
    whirlpoolAddress: yup
      .string()
      .required("Whirlpool address is required")
      .test(
        "is-valid-address",
        "Please enter a valid Whirlpool address",
        (value) => {
          if (!value) return false;
          try {
            new PublicKey(value);
            return true;
          } catch {
            return false;
          }
        }
      ),
    lowerPrice: yup
      .number()
      .required("Lower price is required")
      .moreThan(0, "Lower price must be greater than 0"),
    upperPrice: yup
      .number()
      .required("Upper price is required")
      .moreThan(
        yup.ref('lowerPrice'),
        "Upper price must be greater than lower price"
      ),
    tokenAmount: yup
      .number()
      .required("Token amount is required")
      .moreThan(0, "Token amount must be greater than 0"),
    tokenSide: yup
      .string()
      .required("Token side is required")
      .oneOf(["A", "B"], "Token side must be either A or B"),
    slippage: yup
      .number()
      .required("Slippage is required")
      .min(0.01, "Slippage must be at least 0.01%")
      .max(100, "Slippage cannot exceed 100%"),
  });
 
  // Build and serialize the instruction
  const getInstruction = async (): Promise<UiInstruction> => {
    const { isValid, validationErrors } = await isFormValid(schema, form);
    setFormErrors(validationErrors);
    
    if (
      !isValid ||
      !form.governedAccount?.governance?.account ||
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
      // Import entire SDK to avoid import errors
      const orcaSdk = await import('@orca-so/whirlpools-sdk');
      
      // Create a fake wallet for the governed account
      const funder = form.governedAccount.governance.pubkey;
      const fakeWallet = {
        publicKey: funder, 
        signTransaction: async (tx: any) => tx,
        signAllTransactions: async (txs: any) => txs
      };
      
      // Initialize an anchor provider
      const { AnchorProvider } = await import('@coral-xyz/anchor');
      const provider = new AnchorProvider(connection.current, fakeWallet, {});
      
      // Create context for Whirlpool operations
      const ctx = orcaSdk.WhirlpoolContext.withProvider(
        provider,
        ORCA_WHIRLPOOL_PROGRAM_ID
      );
      
      // Get whirlpool address
      const whirlpoolAddress = new PublicKey(form.whirlpoolAddress);
      
      // Initialize the account fetcher
      const fetcher = new orcaSdk.AccountFetcher(connection.current);
      
      // Build whirlpool client
      const client = orcaSdk.buildWhirlpoolClient(ctx);
      
      // Get pool data
      const pool = await client.getPool(whirlpoolAddress);
      const poolData = pool.getData();
      const tokenAInfo = pool.getTokenAInfo();
      const tokenBInfo = pool.getTokenBInfo();
      
      // Calculate tick indices based on price bounds
      const tokenADecimals = tokenAInfo.decimals;
      const tokenBDecimals = tokenBInfo.decimals;
      
      const tickLower = orcaSdk.TickUtil.getInitializableTickIndex(
        orcaSdk.PriceMath.priceToTickIndex(
          new Decimal(form.lowerPrice),
          tokenADecimals,
          tokenBDecimals
        ),
        poolData.tickSpacing
      );
      
      const tickUpper = orcaSdk.TickUtil.getInitializableTickIndex(
        orcaSdk.PriceMath.priceToTickIndex(
          new Decimal(form.upperPrice),
          tokenADecimals,
          tokenBDecimals
        ),
        poolData.tickSpacing
      );
      
      // Get token mint based on side
      const tokenMint = form.tokenSide === "A" 
        ? poolData.tokenMintA
        : poolData.tokenMintB;
      
      // Create a quote for the liquidity
      const slippagePercent = orcaSdk.Percentage.fromFraction(form.slippage, 100);
      
      // Get the quote for liquidity
      const quote = orcaSdk.increaseLiquidityQuoteByInputToken(
        tokenMint,
        new Decimal(form.tokenAmount),
        tickLower,
        tickUpper,
        slippagePercent,
        pool,
        fetcher // Adding required fetcher parameter
      );
      
      console.log("Quote for position:", {
        tokenMaxA: quote.tokenMaxA.toString(),
        tokenMaxB: quote.tokenMaxB.toString(),
      });
      
      // Use the direct method from the documentation to open position
      const { positionMint, tx } = await pool.openPosition(
        tickLower,
        tickUpper,
        quote
      );
      
      // Get all the instructions from the transaction
      // Rather than attempting to access private fields or builder methods,
      // we'll use the serialize method which is safer
      
      // We need to get the transaction serialized
      // Since we're in a DAO proposal context, we need the individual 
      // instructions, not the transaction itself      
      
      // For simplicity, and since the tx object structure may be complex,
      // we'll use a simpler approach based on the documentation
      
      // Simplified approach: use specific instruction builders from SDK
      // directly instead of the transaction builder
      
      // Create position mint keypair
      const positionMintKeypair = new orcaSdk.Keypair();
      
      // Get position PDA
      const positionPda = orcaSdk.PDAUtil.getPosition(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        positionMintKeypair.publicKey
      );
      
      // Get metadata PDA
      const metadataPda = orcaSdk.PDAUtil.getPositionMetadata(
        positionMintKeypair.publicKey
      );
      
      // Create position token account
      const { token } = await import('@solana/spl-token');
      const positionTokenAccountAddress = token.getAssociatedTokenAddressSync(
        positionMintKeypair.publicKey,
        funder
      );
      
      // Build instructions manually based on documentation
      // 1. Initialize tick arrays if needed
      const tickArrayLower = orcaSdk.PDAUtil.getTickArrayFromTickIndex(
        tickLower,
        poolData.tickSpacing,
        whirlpoolAddress,
        ORCA_WHIRLPOOL_PROGRAM_ID
      );
      
      const tickArrayUpper = orcaSdk.PDAUtil.getTickArrayFromTickIndex(
        tickUpper,
        poolData.tickSpacing,
        whirlpoolAddress,
        ORCA_WHIRLPOOL_PROGRAM_ID
      );
      
      // 2. Create open position instruction
      const openPositionIx = orcaSdk.WhirlpoolIx.openPositionWithMetadataIx(
        ctx.program,
        {
          funder: funder,
          owner: funder,
          positionPda: positionPda,
          metadataPda: metadataPda,
          positionMintAddress: positionMintKeypair.publicKey,
          positionTokenAccountAddress: positionTokenAccountAddress,
          whirlpool: whirlpoolAddress,
          tickLowerIndex: tickLower,
          tickUpperIndex: tickUpper,
        }
      );
      
      // 3. Create increase liquidity instruction
      const increaseLiquidityIx = orcaSdk.WhirlpoolIx.increaseLiquidityIx(
        ctx.program,
        {
          liquidityAmount: quote.liquidity,
          tokenMaxA: quote.tokenMaxA,
          tokenMaxB: quote.tokenMaxB,
          whirlpool: whirlpoolAddress,
          positionAuthority: funder,
          position: positionPda.publicKey,
          positionTokenAccount: positionTokenAccountAddress,
          tokenOwnerAccountA: null, // Will be filled by SDK
          tokenOwnerAccountB: null, // Will be filled by SDK
          tokenVaultA: poolData.tokenVaultA,
          tokenVaultB: poolData.tokenVaultB,
          tickArrayLower: tickArrayLower.publicKey,
          tickArrayUpper: tickArrayUpper.publicKey,
        }
      );
      
      // Collect all instructions
      const allInstructions = [openPositionIx, increaseLiquidityIx];
      
      if (!allInstructions || allInstructions.length === 0) {
        throw new Error("Failed to generate instructions");
      }
      
      // Serialize all instructions
      const serializedInstructions = allInstructions.map(ix => 
        serializeInstructionToBase64(ix)
      );
      
      console.log("Creating Orca Position with liquidity:", {
        whirlpool: whirlpoolAddress.toString(),
        positionMint: positionMintKeypair.publicKey.toString(),
        tickLower,
        tickUpper,
        tokenSide: form.tokenSide,
        tokenAmount: form.tokenAmount,
        instructionCount: allInstructions.length
      });
      
      return {
        serializedInstruction: serializedInstructions[0],
        isValid: true,
        governance: form.governedAccount?.governance,
        additionalSerializedInstructions: serializedInstructions.slice(1),
        chunkBy: 2, // Group up to 2 instructions per transaction
      };
    } catch (e) {
      console.error("Error creating position and adding liquidity:", e);
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
      };
    }
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
      label: "Whirlpool Address",
      initialValue: form.whirlpoolAddress,
      type: InstructionInputType.INPUT,
      name: "whirlpoolAddress",
      placeholder: "Enter the address of the Whirlpool",
    },
    {
      label: "Lower Price",
      initialValue: form.lowerPrice,
      type: InstructionInputType.INPUT,
      inputType: "number",
      name: "lowerPrice",
      placeholder: "Lower price bound for your position",
    },
    {
      label: "Upper Price",
      initialValue: form.upperPrice,
      type: InstructionInputType.INPUT,
      inputType: "number",
      name: "upperPrice",
      placeholder: "Upper price bound for your position",
    },
    {
      label: "Token Side",
      initialValue: form.tokenSide,
      type: InstructionInputType.SELECT,
      name: "tokenSide",
      options: [
        { name: "Token A", value: "A" },
        { name: "Token B", value: "B" },
      ],
      placeholder: "Select which token to provide",
    },
    {
      label: "Token Amount",
      initialValue: form.tokenAmount,
      type: InstructionInputType.INPUT,
      inputType: "number",
      name: "tokenAmount",
      placeholder: "Amount of tokens to deposit",
    },
    {
      label: "Slippage Tolerance (%)",
      initialValue: form.slippage,
      type: InstructionInputType.INPUT,
      inputType: "number",
      name: "slippage",
      placeholder: "Slippage tolerance in percentage (e.g., 1 for 1%)",
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
 
export default OpenPositionAddLiquidity;
