import { useContext, useEffect, useState } from 'react'
import * as yup from 'yup'
import { ProgramAccount, Governance, serializeInstructionToBase64 } from '@solana/spl-governance'
import { validateInstruction } from '@utils/instructionTools'
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes'
import { PublicKey } from '@solana/web3.js'
import { NewProposalContext } from '../../../new'
import InstructionForm, { InstructionInput } from '../FormCreator'
import { InstructionInputType } from '../inputInstructionType'
import { AssetAccount } from '@utils/uiTypes/assets'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import { useRealmQuery } from '@hooks/queries/realm'
import useGovernanceAssets from '@hooks/useGovernanceAssets'
import { useOrcaClient } from '@hooks/useOrcaClient'
import { Instructions } from '@utils/uiTypes/proposalCreationTypes'

interface CreatePoolForm {
  governedAccount: AssetAccount | undefined
  tokenAMint: string
  tokenBMint: string
  initialPrice: number
  isConcentrated?: boolean
}

export default function CreatePool({
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
  const { orcaClient } = useOrcaClient()

  const [form, setForm] = useState<CreatePoolForm>({
    governedAccount: undefined,
    tokenAMint: '',
    tokenBMint: '',
    initialPrice: 0.01,
    isConcentrated: false,
  })
  const [formErrors, setFormErrors] = useState({})

  const shouldBeGoverned = !!(index !== 0 && governance)

  // YUP validation
  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account is required'),
    tokenAMint: yup.string().required('Token A mint is required'),
    tokenBMint: yup.string().required('Token B mint is required'),
    initialPrice: yup.number().positive().required('Initial price > 0'),
    isConcentrated: yup.boolean(),
  })

  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors })
    let serializedInstruction = ''

    if (
      isValid &&
      form?.governedAccount?.governance?.account &&
      wallet?.publicKey &&
      orcaClient
    ) {
      const ixs = await orcaClient.createPool({
        tokenAMint: new PublicKey(form.tokenAMint),
        tokenBMint: new PublicKey(form.tokenBMint),
        initialPrice: form.initialPrice,
        isConcentrated: form.isConcentrated,
      })

      // Often we only allow 1 instruction per component, but Realms supports multiple.
      // If you have multiple ixs, you can either combine them or store them in `additionalSerializedInstructions`.
      if (ixs.length) {
        // Just base64-serialize the FIRST instruction, as a basic example
        serializedInstruction = serializeInstructionToBase64(ixs[0])
      }
    }

    return {
      serializedInstruction,
      isValid,
      governance: form?.governedAccount?.governance,
    }
  }

  // The fields to show in UI
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
      type: InstructionInputType.SWITCH, // or check
    },
  ]

  useEffect(() => {
    handleSetInstructions(
      {
        governedAccount: form?.governedAccount?.governance,
        getInstruction,
      },
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
