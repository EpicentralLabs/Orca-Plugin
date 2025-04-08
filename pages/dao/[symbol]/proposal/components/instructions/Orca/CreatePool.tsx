import { useContext, useEffect, useState } from 'react';
import * as yup from 'yup';
import {
  ProgramAccount,
  Governance,
  serializeInstructionToBase64,
} from '@solana/spl-governance';
import { validateInstruction } from '@utils/instructionTools';
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { NewProposalContext } from '../../../new';
import InstructionForm, { InstructionInput } from '../FormCreator';
import { InstructionInputType } from '../inputInstructionType';
import { AssetAccount } from '@utils/uiTypes/assets';
import useWalletOnePointOh from '@hooks/useWalletOnePointOh';
import { useRealmQuery } from '@hooks/queries/realm';
import useGovernanceAssets from '@hooks/useGovernanceAssets';
import {
  createSplashPoolInstructions,
  createConcentratedLiquidityPoolInstructions,
  setWhirlpoolsConfig,
} from '@orca-so/whirlpools';
import { createSolanaRpc, mainnet } from '@solana/kit';

// If needed, declare our Address type as string.
type Address = string;

interface CreatePoolForm {
  governedAccount: AssetAccount | undefined;
  tokenAMint: string;
  tokenBMint: string;
  initialPrice: number;
  isConcentrated?: boolean;
}

export default function CreatePool({
                                     index,
                                     governance,
                                   }: {
  index: number;
  governance: ProgramAccount<Governance> | null;
}) {
  const { handleSetInstructions } = useContext(NewProposalContext);
  const { assetAccounts } = useGovernanceAssets();
  const wallet = useWalletOnePointOh();

  const [form, setForm] = useState<CreatePoolForm>({
    governedAccount: undefined,
    tokenAMint: '',
    tokenBMint: '',
    initialPrice: 0.01,
    isConcentrated: false,
  });
  const [formErrors, setFormErrors] = useState({});

  const shouldBeGoverned = !!(index !== 0 && governance);

  // Yup validation schema.
  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account is required'),
    tokenAMint: yup.string().required('Token A mint is required'),
    tokenBMint: yup.string().required('Token B mint is required'),
    initialPrice: yup.number().positive().required('Initial price > 0'),
    isConcentrated: yup.boolean(),
  });

  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors });
    let serializedInstruction = '';

    if (isValid && form?.governedAccount?.governance?.account && wallet?.publicKey) {
      // Create an RPC connection targeting mainnet.
      const rpc = createSolanaRpc(mainnet('https://api.mainnet-beta.solana.com'));
      // Set Whirlpools configuration to mainnet.
      await setWhirlpoolsConfig('solanaMainnet');

      // Suppress the error for Address conversion.
      // @ts-ignore
      const tokenAMintAddress: Address = new PublicKey(form.tokenAMint).toString();
      // @ts-ignore
      const tokenBMintAddress: Address = new PublicKey(form.tokenBMint).toString();

      let instructions: TransactionInstruction[] = [];

      if (!form.isConcentrated) {
        const result = await createSplashPoolInstructions(
          rpc,
          tokenAMintAddress,
          tokenBMintAddress,
          form.initialPrice
        );
        // @ts-ignore
        instructions = result.instructions.map((ix) => ix as TransactionInstruction);
      } else {
        const tickSpacing = 64; // Example value.
        const result = await createConcentratedLiquidityPoolInstructions(
          rpc,
          tokenAMintAddress,
          tokenBMintAddress,
          tickSpacing,
          form.initialPrice
        );
        // @ts-ignore
        instructions = result.instructions.map((ix) => ix as TransactionInstruction);
      }

      if (instructions.length > 0) {
        serializedInstruction = serializeInstructionToBase64(instructions[0]);
      }
    }

    return {
      serializedInstruction,
      isValid,
      governance: form?.governedAccount?.governance,
    };
  }

  const inputs: InstructionInput[] = [
    {
      label: 'Governance',
      initialValue: null,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts,
    },
    {
      label: 'Token A Mint',
      initialValue: '',
      name: 'tokenAMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Token B Mint',
      initialValue: '',
      name: 'tokenBMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Initial Price',
      initialValue: 0.01,
      name: 'initialPrice',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
    {
      label: 'Concentrated Pool?',
      initialValue: false,
      name: 'isConcentrated',
      type: InstructionInputType.SWITCH,
    },
  ];

  useEffect(() => {
    handleSetInstructions(
      {
        governedAccount: form?.governedAccount?.governance,
        getInstruction,
      },
      index
    );
  }, [form, handleSetInstructions, index, form?.governedAccount]);

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
