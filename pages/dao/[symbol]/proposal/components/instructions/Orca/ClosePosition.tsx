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
  TransactionInstruction as Web3jsTransactionInstruction, // Alias for clarity
  Keypair,
  Transaction, // Keep web3.js Transaction type
  ConfirmOptions,
  SystemProgram,
  AccountInfo,
  VersionedTransaction, // Import VersionedTransaction for potential wallet signature needs
} from '@solana/web3.js';
import { NewProposalContext } from '../../../new';
import InstructionForm, { InstructionInput } from '../FormCreator';
import { InstructionInputType } from '../inputInstructionType';
import { AssetAccount } from '@utils/uiTypes/assets';
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'; // Your existing web3.js wallet hook
import { useRealmQuery } from '@hooks/queries/realm';
import useGovernanceAssets from '@hooks/useGovernanceAssets';
import useLegacyConnectionContext from '@hooks/useLegacyConnectionContext'; // Your existing web3.js connection hook

// --- Import from NEWER Orca SDK ---
import {
  // ORCA_WHIRLPOOL_PROGRAM_ID, // Removed - Not exported directly
  closePositionInstructions, // The function from the newer SDK
  setWhirlpoolsConfig, // Function to set config address (devnet/mainnet)
} from '@orca-so/whirlpools';

// --- Import from @solana/kit for RPC and Address ---
import { createSolanaRpc } from '@solana/kit'; // Use kit's RPC creator
import { Address } from '@solana/addresses'; // Newer SDK uses Address type (branded string)
// import { SolanaRpcApi } from '@solana/rpc-core'; // Removed - Cannot find module error

// --- Import supporting types ---
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';
import { Percentage } from '@orca-so/common-sdk'; // May not be needed if SDK takes BPS


// --- Form State Interface ---
interface ClosePositionForm {
  governedAccount?: AssetAccount; // Represents the authority over the position NFT
  positionMint: string;
  slippageBps: number; // Basis points (e.g., 50 for 0.5%)
}

// --- React Component ---
export default function ClosePosition({
                                        index,
                                        governance,
                                      }: {
  index: number;
  governance: ProgramAccount<Governance> | null;
}) {
  // --- Hooks ---
  const { handleSetInstructions } = useContext(NewProposalContext);
  const connection = useLegacyConnectionContext(); // Your web3.js connection
  const realm = useRealmQuery().data?.result;
  const { assetAccounts } = useGovernanceAssets();
  const wallet = useWalletOnePointOh(); // Your web3.js wallet adapter

  // --- State ---
  const [form, setForm] = useState<ClosePositionForm>({
    governedAccount: undefined,
    positionMint: '',
    slippageBps: 50,
  });
  const [formErrors, setFormErrors] = useState({});
  const shouldBeGoverned = !!(index !== 0 && governance);

  // --- Validation Schema ---
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required('Governance account (Position Authority) is required'),
    positionMint: yup
      .string()
      .required('Position NFT Mint address is required')
      .test('is-pubkey', 'Invalid Position Mint address', (value) => {
        try { new PublicKey(value || ''); return true; } catch (e) { return false; }
      }),
    slippageBps: yup
      .number()
      .transform((value) => (isNaN(value) ? 0 : value))
      .min(0)
      .max(10000)
      .required('Slippage is required'),
  });

  // --- getInstruction Implementation ---
  async function getInstruction(): Promise<UiInstruction> {
    setFormErrors({});
    const isValid = await validateInstruction({ schema, form, setFormErrors });
    const prerequisiteInstructions: Web3jsTransactionInstruction[] = [];
    const prerequisiteInstructionsSigners: Keypair[] = [];
    const additionalSerializedInstructions: string[] = [];

    if (
      !isValid ||
      !form.governedAccount?.governance?.account ||
      !form.governedAccount?.extensions.transferAddress || // Authority address
      !wallet?.publicKey || // Funder wallet
      !connection.current
    ) {
      if (!form.governedAccount?.extensions.transferAddress && form.governedAccount) {
        setFormErrors({ governedAccount: 'Selected governed account does not have a valid authority address.' });
      }
      if (!wallet?.connected) {
        setFormErrors({ _error: 'Wallet not connected.' });
      }
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions, prerequisiteInstructionsSigners, additionalSerializedInstructions: [] };
    }

    try {
      // --- Authority & Funder ---
      const positionAuthority = form.governedAccount.extensions.transferAddress; // web3.js PublicKey
      const funderWallet = wallet; // web3.js wallet adapter

      // --- Set Whirlpools Config (Required by newer SDK) ---
      await setWhirlpoolsConfig('solanaMainnet'); // Or 'solanaDevnet'

      // --- Create RPC Client using @solana/kit ---
      // Use the endpoint from your existing web3.js connection
      // Type is inferred from createSolanaRpc return value
      const rpc = createSolanaRpc(connection.current.rpcEndpoint);

      // --- Prepare Position Mint ---
      // The newer SDK uses a branded string type 'Address'
      const positionMintAddress = form.positionMint as Address;

      // --- Call the Newer SDK function ---
      console.log(`Calling closePositionInstructions for mint: ${positionMintAddress}`);
      console.log(`Funder (passing wallet directly): ${funderWallet?.publicKey?.toBase58()}`);
      console.log(`Position Authority (governed account): ${positionAuthority.toBase58()}`);
      console.log(`Slippage BPS: ${form.slippageBps}`);

      // Pass the raw funder wallet directly, casting as 'any' to bypass the strict TransactionSigner type check.
      // This relies on the SDK function potentially only needing compatible .publicKey and .signTransaction properties at runtime.
      if (!funderWallet.signTransaction || !funderWallet.publicKey) {
        throw new Error("Connected wallet doesn't have publicKey or signTransaction method.");
      }
      const {
        instructions: kitInstructions, // These are @solana/transactions instructions
        // quote, feesQuote, rewardsQuote // Optional return values
      } = await closePositionInstructions(
        rpc, // Pass the RPC client created by @solana/kit
        positionMintAddress,
        form.slippageBps, // Pass slippage as BPS
        funderWallet as any // Pass raw wallet object, cast to 'any'
      );

      console.log(`Received ${kitInstructions.length} instructions from SDK.`);

      // --- Attempt to Convert/Cast Instructions (RISKY) ---
      // This assumes the structure is compatible enough for serialization.
      // If serializeInstructionToBase64 fails, this assumption is wrong.
      const web3JsInstructions = kitInstructions as unknown as Web3jsTransactionInstruction[];
      console.warn("Attempting to cast @solana/transactions instructions to @solana/web3.js format. This might fail if structures differ significantly.");


      // --- Serialize Instructions ---
      const finalInstructions = [...prerequisiteInstructions, ...web3JsInstructions];
      finalInstructions.forEach((ix, idx) => {
        // Add extra validation before serializing if possible
        if (!ix || !ix.keys || !ix.programId) {
          console.error("Instruction structure seems invalid after casting:", ix);
          throw new Error(`Instruction at index ${idx} has invalid structure after casting.`);
        }
        console.log(`Serializing instruction ${idx + 1}/${finalInstructions.length}`);
        additionalSerializedInstructions.push(serializeInstructionToBase64(ix));
      });

      console.log('Instructions serialized successfully.');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      console.error('Error creating Orca close position instruction:', error);
      // Provide more specific feedback if possible
      if (errorMessage.includes("signTransaction") || errorMessage.includes("TransactionSigner")) {
        setFormErrors({ _error: `Wallet object might be incompatible with expected signer type: ${errorMessage}` });
      } else if (errorMessage.includes("serializeInstructionToBase64") || errorMessage.includes("invalid structure")) {
        setFormErrors({ _error: `Failed to serialize instructions - format mismatch likely: ${errorMessage}` });
      }
      else {
        setFormErrors({ _error: `Failed to create instruction: ${errorMessage}` });
      }
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions: [], prerequisiteInstructionsSigners: [], additionalSerializedInstructions: [] };
    }

    // --- Return UiInstruction ---
    return {
      serializedInstruction: '', // Keep empty as per pattern
      isValid: true,
      governance: form.governedAccount?.governance,
      prerequisiteInstructions: [],
      prerequisiteInstructionsSigners,
      additionalSerializedInstructions,
      chunkBy: 3, // Adjust chunk size as needed
    };
  }

  // --- Form Inputs Definition ---
  const inputs: InstructionInput[] = [
    {
      label: 'Position Authority (Governance Account)',
      initialValue: form.governedAccount,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts.filter(acc => !!acc.extensions.transferAddress),
    },
    {
      label: 'Position NFT Mint Address',
      initialValue: form.positionMint,
      name: 'positionMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Acceptable Slippage (BPS)',
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, governance, index, handleSetInstructions]);

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
