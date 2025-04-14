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
  Transaction,
  ConfirmOptions,
  SystemProgram,
  AccountInfo,
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
  setWhirlpoolsConfig,
  harvestPositionInstructions, // Collects fees AND rewards
} from '@orca-so/whirlpools';

// --- Import from @solana/kit for RPC and Address ---
import { createSolanaRpc } from '@solana/kit'; // Use kit's RPC creator
import { Address } from '@solana/addresses'; // Newer SDK uses Address type (branded string)

// --- Import supporting types/libs ---
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';

// --- Form State Interface ---
interface CollectFeesForm {
  governedAccount?: AssetAccount; // Represents the authority over the position NFT
  positionMint: string;
}

// --- React Component ---
// Note: Renamed slightly for clarity as it collects rewards too
export default function CollectFeesAndRewards({
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
  const [form, setForm] = useState<CollectFeesForm>({
    governedAccount: undefined,
    positionMint: '',
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
        setFormErrors(prev => ({...prev, governedAccount: 'Selected governed account does not have a valid authority address.' }));
      }
      if (!wallet?.connected) {
        setFormErrors(prev => ({...prev, _error: 'Wallet not connected.' }));
      }
      return { serializedInstruction: '', isValid: false, governance: form.governedAccount?.governance, prerequisiteInstructions, prerequisiteInstructionsSigners, additionalSerializedInstructions: [] };
    }

    try {
      // --- Authority & Funder ---
      // Authority is derived from the governed account, its signature is handled by SPL Gov.
      const positionAuthority = form.governedAccount.extensions.transferAddress;
      // Funder is the connected wallet, passed to the SDK.
      const funderWallet = wallet;

      // --- Set Whirlpools Config ---
      await setWhirlpoolsConfig('solanaMainnet');

      // --- Create RPC Client ---
      const rpc = createSolanaRpc(connection.current.rpcEndpoint);

      // --- Prepare Position Mint ---
      const positionMintAddress = form.positionMint as Address;

      // --- Wallet for SDK (Funder) ---
      if (!funderWallet.signTransaction || !funderWallet.publicKey) {
        throw new Error("Connected wallet doesn't have publicKey or signTransaction method.");
      }
      const funderSigner = funderWallet as any; // Cast funder wallet

      // --- Call the Newer SDK function ---
      // The 'wallet' parameter here likely acts as the funder and potentially the receiver
      // of funds if specific destination accounts aren't derived/provided internally.
      // Crucially, the on-chain program checks the actual positionAuthority signature provided by SPL Gov.
      console.log(`Calling harvestPositionInstructions for mint: ${positionMintAddress}`);
      console.log(`Funder (passing wallet directly): ${funderWallet?.publicKey?.toBase58()}`);
      console.log(`Position Authority (governed account): ${positionAuthority.toBase58()}`);


      const {
        instructions: kitInstructions, // These are @solana/transactions instructions
        // feesQuote, rewardsQuote // Optional return values for UI display
      } = await harvestPositionInstructions(
        rpc,
        positionMintAddress,
        funderSigner // Pass funder wallet (cast as any)
        // Note: The docs example shows harvestPositionInstructions(rpc, positionMint, wallet)
        // It implicitly uses the 'wallet' as the authority/receiver in that context.
        // For DAO, we rely on SPL Gov for authority sig, funder pays fees.
      );

      console.log(`Received ${kitInstructions.length} instructions from SDK.`);

      // --- Attempt to Convert/Cast Instructions (RISKY) ---
      const web3JsInstructions = kitInstructions as unknown as Web3jsTransactionInstruction[];
      console.warn("Attempting to cast @solana/transactions instructions to @solana/web3.js format. This might fail if structures differ significantly.");

      // --- Serialize Instructions ---
      const finalInstructions = [...prerequisiteInstructions, ...web3JsInstructions];
      finalInstructions.forEach((ix, idx) => {
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
      console.error('Error creating Orca harvest instruction:', error);
      if (errorMessage.includes("signTransaction")) {
        setFormErrors({ _error: `Wallet signing function might be incompatible: ${errorMessage}` });
      } else if (errorMessage.includes("serializeInstructionToBase64") || errorMessage.includes("invalid structure")) {
        setFormErrors({ _error: `Failed to serialize instructions - format mismatch likely: ${errorMessage}` });
      } else {
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
      chunkBy: 2, // Harvesting might involve update + collect fees + collect rewards (multiple)
    };
  }

  // --- Form Inputs Definition ---
  const inputs: InstructionInput[] = [
    {
      label: 'Position Authority (Governance Account)',
      // tooltip: 'The DAO account that owns the Position NFT whose fees/rewards will be collected.', // Add back if type allows
      initialValue: form.governedAccount,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts.filter(acc => !!acc.extensions.transferAddress),
    },
    {
      label: 'Position NFT Mint Address',
      // tooltip: 'The mint address of the Orca Position NFT.', // Add back if type allows
      initialValue: form.positionMint,
      name: 'positionMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
  ];

  // --- useEffect to Register Instruction ---
  useEffect(() => {
    handleSetInstructions(
      { governedAccount: form.governedAccount?.governance, getInstruction },
      index
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, governance, index, handleSetInstructions]); // Include all dependencies

  // --- Render Component ---
  return (
    // Renamed component slightly
    <InstructionForm
      outerForm={form}
      setForm={setForm}
      inputs={inputs}
      setFormErrors={setFormErrors}
      formErrors={formErrors}
    />
  );
}
