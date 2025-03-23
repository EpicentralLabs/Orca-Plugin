import { useContext, useEffect, useState } from 'react'
import * as yup from 'yup'
import {
  ProgramAccount,
  Governance,
  serializeInstructionToBase64,
} from '@solana/spl-governance'
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
import {
  setWhirlpoolsConfig,
  openPositionInstructions,
  openFullRangePositionInstructions,
} from '@orca-so/whirlpools'

interface CreatePositionForm {
  governedAccount?: AssetAccount
  poolAddress: string
  tokenA: number
  tokenB: number
  lowerPrice?: number
  upperPrice?: number
  slippageBps?: number
  splash?: boolean
}

export default function CreatePosition({
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

  const [form, setForm] = useState<CreatePositionForm>({
    poolAddress: '',
    tokenA: 0,
    tokenB: 0,
    splash: false,
    slippageBps: 100,
  })
  const [formErrors, setFormErrors] = useState({})

  const shouldBeGoverned = !!(index !== 0 && governance)

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governed account is required'),
    poolAddress: yup.string().required('Pool address is required'),
    tokenA: yup.number().min(0),
    tokenB: yup.number().min(0),
  })

  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors })
    let serializedInstruction = ''

    if (isValid && form.governedAccount?.governance?.account && wallet?.publicKey) {
      await setWhirlpoolsConfig('solanaDevnet')

      const poolPubkey = new PublicKey(form.poolAddress)
      let instructions = []
      if (form.splash) {
        // Splash => openFullRangePosition
        const param = {} as any
        if (form.tokenA) param.tokenA = BigInt(form.tokenA)
        if (form.tokenB) param.tokenB = BigInt(form.tokenB)
        const result = await openFullRangePositionInstructions(
          undefined,
          poolPubkey,
          param,
          form.slippageBps ?? 100,
          wallet
        )
        instructions = result.instructions
      } else {
        // Concentrated => openPositionInstructions
        const param = {} as any
        if (form.tokenA) param.tokenA = BigInt(form.tokenA)
        if (form.tokenB) param.tokenB = BigInt(form.tokenB)

        const lower = form.lowerPrice ?? 0.001
        const upper = form.upperPrice ?? 100.0

        const result = await openPositionInstructions(
          undefined,
          poolPubkey,
          param,
          lower,
          upper,
          form.slippageBps ?? 100,
          wallet
        )
        instructions = result.instructions
      }

      if (instructions.length > 0) {
        serializedInstruction = serializeInstructionToBase64(instructions[0])
      }
    }

    return {
      serializedInstruction,
      isValid,
      governance: form.governedAccount?.governance,
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
      label: 'Token A Amount',
      initialValue: 0,
      name: 'tokenA',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
    {
      label: 'Token B Amount',
      initialValue: 0,
      name: 'tokenB',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
    {
      label: 'Lower Price (if Concentrated)',
      initialValue: 0.001,
      name: 'lowerPrice',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
    {
      label: 'Upper Price (if Concentrated)',
      initialValue: 100.0,
      name: 'upperPrice',
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
    {
      label: 'Use Splash Pool?',
      initialValue: false,
      name: 'splash',
      type: InstructionInputType.SWITCH,
    },
  ]

  useEffect(() => {
    handleSetInstructions(
      {
        governedAccount: form.governedAccount?.governance,
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
