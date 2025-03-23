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

// Import from the High-Level Whirlpools SDK
import {
  setWhirlpoolsConfig,
  openFullRangePositionInstructions,
  openPositionInstructions,
} from '@orca-so/whirlpools'

interface AddLiquidityForm {
  governedAccount?: AssetAccount
  whirlpoolAddress: string
  // We’ll accept one param for Splash (tokenA) or multiple for concentrated
  tokenAAmount: number
  tokenBAmount?: number
  isConcentrated?: boolean
  slippageBps?: number
}

export default function AddLiquidity({
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

  const [form, setForm] = useState<AddLiquidityForm>({
    whirlpoolAddress: '',
    tokenAAmount: 0,
    tokenBAmount: 0,
    isConcentrated: false,
    slippageBps: 100,
  })
  const [formErrors, setFormErrors] = useState({})

  const shouldBeGoverned = !!(index !== 0 && governance)

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account is required'),
    whirlpoolAddress: yup.string().required('Pool address is required'),
    tokenAAmount: yup.number().positive().required('Token A amount > 0'),
    // tokenB is optional if you rely on “one-sided” or if it’s a full range
    slippageBps: yup.number().min(0).max(10000).required('Slippage in BPS required'),
  })

  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors })
    let serializedInstruction = ''

    if (isValid && form?.governedAccount?.governance?.account && wallet?.publicKey) {
      await setWhirlpoolsConfig('solanaDevnet')
      // Optionally: setDefaultFunder(wallet) if needed

      const poolPubkey = new PublicKey(form.whirlpoolAddress)
      const param = { tokenA: BigInt(form.tokenAAmount) }
      // If using concentrated liquidity, allow a param for tokenB as well
      if (form.tokenBAmount && form.isConcentrated) {
        param['tokenB'] = BigInt(form.tokenBAmount)
      }

      let instructions = []
      if (!form.isConcentrated) {
        // For Splash: openFullRangePosition
        const result = await openFullRangePositionInstructions(
          // rpc, pool, param, slippageBps, authority
          // devnetRpc omitted here—assuming you have a global or kit usage
          undefined,
          poolPubkey,
          param,
          form.slippageBps,
          wallet
        )
        instructions = result.instructions
      } else {
        // For Concentrated: openPositionInstructions
        const result = await openPositionInstructions(
          undefined,
          poolPubkey,
          param,
          0.001, // lower price bound
          100.0, // upper price bound
          form.slippageBps,
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
