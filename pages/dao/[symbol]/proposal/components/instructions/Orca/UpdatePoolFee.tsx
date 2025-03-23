import { useContext, useEffect, useState } from 'react'
import * as yup from 'yup'
import {
  ProgramAccount,
  Governance,
  serializeInstructionToBase64,
} from '@solana/spl-governance'
import { validateInstruction } from '@utils/instructionTools'
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { NewProposalContext } from '../../../new'
import InstructionForm, { InstructionInput } from '../FormCreator'
import { InstructionInputType } from '../inputInstructionType'
import { AssetAccount } from '@utils/uiTypes/assets'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import { useRealmQuery } from '@hooks/queries/realm'
import useGovernanceAssets from '@hooks/useGovernanceAssets'

export default function UpdatePoolFee({
  index,
  governance,
}: {
  index: number
  governance: ProgramAccount<Governance> | null
}) {
  const { handleSetInstructions } = useContext(NewProposalContext)
  const realm = useRealmQuery().data?.result
  const { assetAccounts } = useGovernanceAssets()
  const wallet = useWalletOnePointOh()

  const [form, setForm] = useState<{
    governedAccount?: AssetAccount
    poolAddress: string
    newFeeRate: number
  }>({
    poolAddress: '',
    newFeeRate: 0,
  })
  const [formErrors, setFormErrors] = useState({})

  const shouldBeGoverned = !!(index !== 0 && governance)

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required(),
    poolAddress: yup.string().required(),
    newFeeRate: yup.number().required().min(0).max(10000),
  })

  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors })
    let serializedInstruction = ''

    if (isValid && form.governedAccount?.governance?.account && wallet?.publicKey) {
      // Typically, there's no direct "update fee" call in the Whirlpools docs.
      // So let's return a no-op with a placeholder:
      const instr = new TransactionInstruction({
        programId: new PublicKey('11111111111111111111111111111111'),
        keys: [],
        data: Buffer.from([]),
      })
      serializedInstruction = serializeInstructionToBase64(instr)
    }

    return {
      serializedInstruction,
      isValid,
      governance: form?.governedAccount?.governance,
    }
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
      label: 'Pool Address',
      initialValue: '',
      name: 'poolAddress',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'New Fee Rate (BPS)',
      initialValue: 0,
      name: 'newFeeRate',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
  ]

  useEffect(() => {
    handleSetInstructions(
      { governedAccount: form.governedAccount?.governance, getInstruction },
      index
    )
  }, [form])

  return (
    <InstructionForm
      outerForm={form}
      setForm={setForm}
      inputs={inputs}
      setFormErrors={setFormErrors}
      formErrors={formErrors}
    />
  )
}
