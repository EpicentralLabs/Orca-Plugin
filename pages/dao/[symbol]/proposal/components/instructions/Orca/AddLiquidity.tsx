import { useContext, useEffect, useState } from 'react';
import * as yup from 'yup';
import { ProgramAccount, Governance, serializeInstructionToBase64 } from '@solana/spl-governance';
import { validateInstruction } from '@utils/instructionTools';
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes';
import { PublicKey, Connection, TransactionInstruction } from '@solana/web3.js';
import { NewProposalContext } from '../../../new';
import InstructionForm, { InstructionInput } from '../FormCreator';
import { InstructionInputType } from '../inputInstructionType';
import { AssetAccount } from '@utils/uiTypes/assets';
import useWalletOnePointOh from '@hooks/useWalletOnePointOh';
import { useRealmQuery } from '@hooks/queries/realm';
import useGovernanceAssets from '@hooks/useGovernanceAssets';

// Import from the High-Level Whirlpools SDK
import {
  setWhirlpoolsConfig,
  openFullRangePositionInstructions,
  openPositionInstructions,
  // Optionally, import setDefaultFunder if needed:
  // setDefaultFunder,
} from '@orca-so/whirlpools';

interface AddLiquidityForm {
  governedAccount?: AssetAccount;
  whirlpoolAddress: string;
  tokenAAmount: number;
  tokenBAmount?: number;
  isConcentrated?: boolean;
  slippageBps?: number;
}

export default function AddLiquidity({
                                       index,
                                       governance,
                                     }: {
  index: number;
  governance: ProgramAccount<Governance> | null;
}) {
  const { handleSetInstructions } = useContext(NewProposalContext);
  const realm = useRealmQuery().data?.result;
  const { assetAccounts } = useGovernanceAssets();
  const wallet = useWalletOnePointOh();

  const [form, setForm] = useState<AddLiquidityForm>({
    whirlpoolAddress: '',
    tokenAAmount: 0,
    tokenBAmount: 0,
    isConcentrated: false,
    slippageBps: 100,
  });
  const [formErrors, setFormErrors] = useState({});

  const shouldBeGoverned = !!(index !== 0 && governance);

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account is required'),
    whirlpoolAddress: yup.string().required('Pool address is required'),
    tokenAAmount: yup.number().positive().required('Token A amount > 0'),
    // tokenBAmount is optional when one-sided or for full range positions
    slippageBps: yup.number().min(0).max(10000).required('Slippage in BPS required'),
  });

  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors });
    let serializedInstruction = '';

    if (isValid && form?.governedAccount?.governance?.account && wallet?.publicKey) {
      // Create a connection to the Solana Devnet.
      const connection = new Connection('https://api.mainnet-beta.solana.com');
      await setWhirlpoolsConfig('solanaMainnet');
      // Optionally set the default funder if necessary:
      // setDefaultFunder(wallet);

      const poolPubkey = new PublicKey(form.whirlpoolAddress);
      const param: { tokenA: bigint; tokenB?: bigint } = { tokenA: BigInt(form.tokenAAmount) };
      if (form.isConcentrated && form.tokenBAmount && form.tokenBAmount > 0) {
        param.tokenB = BigInt(form.tokenBAmount);
      }

      // Explicitly type the instructions array to avoid type never[] errors.
      let instructions: TransactionInstruction[] = [];
      if (!form.isConcentrated) {
        const result = await openFullRangePositionInstructions(
          connection,
          poolPubkey,
          param,
          form.slippageBps,
          wallet
        );
        instructions = result.instructions;
      } else {
        const lowerPrice = 0.001; // Lower price bound (could be made configurable)
        const upperPrice = 100.0; // Upper price bound
        const result = await openPositionInstructions(
          connection,
          poolPubkey,
          param,
          lowerPrice,
          upperPrice,
          form.slippageBps,
          wallet
        );
        instructions = result.instructions;
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
      label: 'Whirlpool Address',
      initialValue: '',
      name: 'whirlpoolAddress',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Token A Amount',
      initialValue: 0,
      name: 'tokenAAmount',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
    {
      label: 'Token B Amount (optional)',
      initialValue: 0,
      name: 'tokenBAmount',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
    {
      label: 'Is Concentrated Pool?',
      initialValue: false,
      name: 'isConcentrated',
      type: InstructionInputType.SWITCH,
    },
    {
      label: 'Slippage BPS (1% = 100 BPS)',
      initialValue: 100,
      name: 'slippageBps',
      type: InstructionInputType.INPUT,
      inputType: 'number',
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
  }, [form, handleSetInstructions, index]);

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
