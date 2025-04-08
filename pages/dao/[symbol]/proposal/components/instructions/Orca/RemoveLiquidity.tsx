import { useContext, useEffect, useState } from 'react';
import * as yup from 'yup';
import { ProgramAccount, Governance, serializeInstructionToBase64 } from '@solana/spl-governance';
import { validateInstruction } from '@utils/instructionTools';
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes';
import { PublicKey, Connection } from '@solana/web3.js';
import { NewProposalContext } from '../../../new';
import InstructionForm, { InstructionInput } from '../FormCreator';
import { InstructionInputType } from '../inputInstructionType';
import { AssetAccount } from '@utils/uiTypes/assets';
import useWalletOnePointOh from '@hooks/useWalletOnePointOh';
import { useRealmQuery } from '@hooks/queries/realm';
import useGovernanceAssets from '@hooks/useGovernanceAssets';
import { setWhirlpoolsConfig, decreaseLiquidityInstructions } from '@orca-so/whirlpools';

interface RemoveLiquidityForm {
  governedAccount?: AssetAccount;
  positionMint: string;
  tokenAAmount?: number;
  tokenBAmount?: number;
  slippageBps?: number;
}

export default function RemoveLiquidity({
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

  const [form, setForm] = useState<RemoveLiquidityForm>({
    positionMint: '',
    tokenAAmount: 0,
    tokenBAmount: 0,
    slippageBps: 100,
  });
  const [formErrors, setFormErrors] = useState({});

  const shouldBeGoverned = !!(index !== 0 && governance);

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account is required'),
    positionMint: yup.string().required('Position mint pubkey is required'),
    slippageBps: yup.number().min(0).max(10000).required('Slippage BPS required'),
  });

  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors });
    let serializedInstruction = '';

    if (isValid && form.governedAccount?.governance?.account && wallet?.publicKey) {
      // Create a connection to the Solana mainnet-beta cluster.
      const connection = new Connection('https://api.mainnet-beta.solana.com');
      await setWhirlpoolsConfig('solanaMainnet');

      // Construct the position mint public key.
      const positionPubkey = new PublicKey(form.positionMint);

      // Prepare the liquidity parameters.
      // Here we require tokenB to be defined.
      const param: { tokenA?: bigint; tokenB: bigint } = {
        tokenB: BigInt(form.tokenBAmount || 0),
      };
      if (form.tokenAAmount) {
        param.tokenA = BigInt(form.tokenAAmount);
      }

      // Decrease partial liquidity from an existing position.
      const { instructions } = await decreaseLiquidityInstructions(
        connection,
        positionPubkey,
        param,
        form.slippageBps ?? 100,
        wallet
      );

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
      label: 'Position Mint',
      initialValue: '',
      name: 'positionMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Token A Amount to remove (optional)',
      initialValue: 0,
      name: 'tokenAAmount',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
    {
      label: 'Token B Amount to remove (optional)',
      initialValue: 0,
      name: 'tokenBAmount',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
    {
      label: 'Slippage BPS',
      initialValue: 100,
      name: 'slippageBps',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
  ];

  useEffect(() => {
    handleSetInstructions(
      { governedAccount: form?.governedAccount?.governance, getInstruction },
      index
    );
  }, [form, handleSetInstructions, index, form.governedAccount]);

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
